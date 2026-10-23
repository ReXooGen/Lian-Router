// Tunnel process lifecycle: one cloudflared quick tunnel per gateway process.
//
// The child is a resource this process owns, so it is deliberately not
// unref'd: an exit hook kills it when the gateway goes away, and `stop()` kills
// it on request. The host cloudflared prints belongs to that child, so it lives
// in memory only — a restart mints a new host and the old one is worthless.
//
// stderr is drained for the whole life of the child, not just until the host
// appears: cloudflared logs continuously, and a pipe nobody reads fills up and
// blocks the process.

import { resolveCloudflaredBinary, resolvePort } from "../../config";
import { setRuntimePublicBaseUrl } from "../../runtime/public-base-url";
import { ConsoleDomainError } from "../shared/errors";
import type { TunnelStatus } from "./contracts";

/** Tail window of stderr kept while scanning; the banner is a few hundred bytes. */
const MAX_STDERR_CAPTURE = 8_192;
/** Every trycloudflare host cloudflared prints, banner and diagnostics alike. */
const TRYCLOUDFLARE_HOST_PATTERN = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/g;
/**
 * Hosts on the trycloudflare domain that are not tunnels: `api` is the quick
 * tunnel *API* endpoint, which cloudflared prints in its own error lines. A
 * naive domain match advertised it as the public URL when the request failed.
 */
const NON_TUNNEL_HOST_LABELS = new Set(["api", "www"]);
/** Bound on the wait for a host, long enough for a slow DNS/QUIC handshake. */
const DEFAULT_START_TIMEOUT_MS = 25_000;
/** Bound on waiting for a killed child to report its exit. */
const STOP_GRACE_MS = 3_000;

/** The minimal child surface the lifecycle needs; Bun's Subprocess satisfies it. */
export interface TunnelChildProcess {
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(): void;
}

/** Injected in tests so no real process is ever spawned. */
export type TunnelSpawn = (command: readonly string[]) => TunnelChildProcess;

export interface TunnelServiceOptions {
  readonly spawn?: TunnelSpawn;
  readonly binary?: string;
  /** Origin the tunnel forwards to; defaults to the listener this process serves. */
  readonly targetUrl?: string;
  readonly startTimeoutMs?: number;
}

interface ActiveTunnel {
  readonly child: TunnelChildProcess;
  readonly startedAt: string;
  readonly hostReady: Promise<string | null>;
  settleHost(host: string | null): void;
  /** Set once the tunnel is advertised; `null` while starting or after a crash. */
  url: string | null;
  /** True when this service killed the child, so its exit is not a failure. */
  stopping: boolean;
  /** True when the operator asked to stop, so a pending start reports that. */
  cancelled: boolean;
  exitCode: number | null;
}

const defaultSpawn: TunnelSpawn = (command) =>
  Bun.spawn([...command], { stdout: "ignore", stderr: "pipe", windowsHide: true });

function waitForExit(child: TunnelChildProcess, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([child.exited.then(() => undefined, () => undefined), grace]).finally(() => {
    clearTimeout(timer);
  });
}

/** First genuine quick-tunnel host in `text`, or `null`. */
function findTunnelHost(text: string): string | null {
  for (const match of text.matchAll(TRYCLOUDFLARE_HOST_PATTERN)) {
    if (match[1] !== undefined && !NON_TUNNEL_HOST_LABELS.has(match[1])) return match[0];
  }
  return null;
}

export class TunnelService {
  private readonly spawn: TunnelSpawn;
  private readonly binary: string;
  private readonly targetUrl: string;
  private readonly startTimeoutMs: number;
  private active: ActiveTunnel | null = null;
  private pendingStart: Promise<TunnelStatus> | null = null;
  private lastError: string | null = null;
  private shutdownHandler: (() => void) | null = null;

  constructor(options: TunnelServiceOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.binary = options.binary ?? resolveCloudflaredBinary();
    this.targetUrl = options.targetUrl ?? `http://127.0.0.1:${resolvePort()}`;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  }

  /**
   * `running` means a public URL is actually being advertised, not merely that
   * a child exists: during the handshake there is nothing for a client to use,
   * and after a crash the host is dead even if the pid lingers.
   */
  status(): TunnelStatus {
    const active = this.active;
    return {
      running: active !== null && active.url !== null,
      publicUrl: active?.url ?? null,
      startedAt: active?.startedAt ?? null,
      error: this.lastError,
    };
  }

  /**
   * Starts the tunnel, or returns the running one.
   *
   * Concurrent callers share a single attempt, so two dashboard tabs pressing
   * Start cannot spawn two cloudflared processes against one gateway.
   */
  async start(): Promise<TunnelStatus> {
    if (this.active !== null) {
      // During the handshake a child exists but no host does yet; the in-flight
      // attempt is the answer, so a second tab joins it instead of being told
      // the tunnel is down.
      return this.pendingStart ?? this.status();
    }
    const pending = this.launch();
    this.pendingStart = pending;
    try {
      return await pending;
    } finally {
      if (this.pendingStart === pending) this.pendingStart = null;
    }
  }

  /** Kills the child and clears the advertised host. Idempotent. */
  async stop(): Promise<TunnelStatus> {
    const active = this.active;
    this.active = null;
    this.lastError = null;
    setRuntimePublicBaseUrl(null);
    if (active !== null) {
      active.cancelled = true;
      this.terminate(active);
      await waitForExit(active.child, STOP_GRACE_MS);
    }
    return this.status();
  }

  /** Kills the child and detaches the process exit hook (tests, teardown). */
  dispose(): void {
    const active = this.active;
    this.active = null;
    setRuntimePublicBaseUrl(null);
    if (active !== null) {
      active.cancelled = true;
      this.terminate(active);
    }
    if (this.shutdownHandler !== null) {
      process.off("exit", this.shutdownHandler);
      this.shutdownHandler = null;
    }
  }

  private async launch(): Promise<TunnelStatus> {
    this.lastError = null;
    let child: TunnelChildProcess;
    try {
      child = this.spawn([this.binary, "tunnel", "--url", this.targetUrl, "--no-autoupdate"]);
    } catch (cause) {
      // Bun throws when the executable is not on PATH, which is the common
      // misconfiguration; a raw spawn error would read as an internal 500.
      const message = `Could not start ${this.binary}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
      this.lastError = message;
      throw new ConsoleDomainError("tunnel_unavailable", 502, message);
    }

    const { promise: hostReady, resolve: settleHost } = Promise.withResolvers<string | null>();
    const active: ActiveTunnel = {
      child,
      startedAt: new Date().toISOString(),
      hostReady,
      settleHost,
      url: null,
      stopping: false,
      cancelled: false,
      exitCode: null,
    };
    this.active = active;
    this.registerShutdownHook();
    void this.drainStderr(active);
    child.exited.then(
      (code) => this.handleExit(active, code),
      () => this.handleExit(active, null),
    );

    try {
      const host = await this.awaitHost(active);
      active.url = host;
      setRuntimePublicBaseUrl(host);
      return this.status();
    } catch (error) {
      if (this.active === active) this.active = null;
      this.terminate(active);
      // A stop that arrives mid-handshake wins over the start it interrupted:
      // reporting a failure for an attempt the operator just cancelled would
      // leave a red banner over the state they asked for.
      if (active.cancelled) return this.status();
      if (error instanceof ConsoleDomainError) {
        this.lastError = error.message;
        throw error;
      }
      const message = `Could not start ${this.binary}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.lastError = message;
      throw new ConsoleDomainError("tunnel_unavailable", 502, message);
    }
  }

  private async awaitHost(active: ActiveTunnel): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { promise: timeout, resolve: expire } = Promise.withResolvers<null>();
    timer = setTimeout(() => expire(null), this.startTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    // Racing the exit as well as the host means a child that dies instantly is
    // reported as an exit, not as a timeout: stderr closing first would
    // otherwise settle the host as "never published" before the exit code is
    // observed. `handleExit` is subscribed before this, so its microtask runs
    // first and `exitCode` is set by the time this resolves.
    const exited = active.child.exited.then(() => null, () => null);
    try {
      const host = await Promise.race([active.hostReady, exited, timeout]);
      if (active.exitCode !== null) {
        throw new ConsoleDomainError(
          "tunnel_unavailable",
          502,
          `Tunnel process exited with code ${active.exitCode} before publishing a host`,
        );
      }
      if (host !== null) return host;
      throw new ConsoleDomainError(
        "tunnel_timeout",
        502,
        `Tunnel did not publish a host within ${Math.round(this.startTimeoutMs / 1000)} s`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reads stderr for the child's lifetime and settles the host on first match. */
  private async drainStderr(active: ActiveTunnel): Promise<void> {
    const stream = active.child.stderr;
    if (stream === null) {
      active.settleHost(null);
      return;
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered = `${buffered}${decoder.decode(value, { stream: true })}`.slice(
          -MAX_STDERR_CAPTURE,
        );
        const host = findTunnelHost(buffered);
        if (host !== null) active.settleHost(host);
      }
    } catch {
      // The pipe closes with the child; the exit handler owns the outcome.
    }
    active.settleHost(null);
  }

  private handleExit(active: ActiveTunnel, code: number | null): void {
    active.exitCode = code;
    // A host minted by a dead process can never serve a client.
    active.settleHost(null);
    if (this.active !== active) return;
    this.active = null;
    setRuntimePublicBaseUrl(null);
    if (!active.stopping) {
      this.lastError =
        code === null
          ? "Tunnel process exited unexpectedly"
          : `Tunnel process exited unexpectedly (code ${code})`;
    }
  }

  private terminate(active: ActiveTunnel): void {
    // `stopping` is the single-writer guard: stop, a mid-handshake cancel, and
    // the exit hook all reach here, and a second kill would target a pid the
    // first one already released.
    if (active.stopping) return;
    active.stopping = true;
    active.settleHost(null);
    active.child.kill();
  }

  /**
   * Kills the child when the gateway exits. The listener is registered once and
   * removed by `dispose()`, so a long-lived process does not accumulate hooks.
   */
  private registerShutdownHook(): void {
    if (this.shutdownHandler !== null) return;
    const handler = (): void => {
      const active = this.active;
      this.active = null;
      if (active !== null) {
        active.cancelled = true;
        this.terminate(active);
      }
    };
    this.shutdownHandler = handler;
    process.once("exit", handler);
  }
}

let sharedTunnelService: TunnelService | null = null;

/**
 * The single tunnel this gateway process owns.
 *
 * Two instances would race for one port-forward and leak a child on every
 * console reload, so the composition root asks for this accessor instead of
 * constructing its own.
 */
export function getTunnelService(): TunnelService {
  sharedTunnelService ??= new TunnelService();
  return sharedTunnelService;
}
