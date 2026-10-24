import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GatewaySupervisor, ServerStatus } from "./supervisor";
import { resolveControlFile } from "./paths";

/**
 * Loopback control plane.
 *
 * The tray host is a separate process and the browser console has no way to
 * signal a CLI it did not spawn, so both talk to this server instead of
 * reaching into process state:
 *
 * - **Loopback only.** The socket binds `127.0.0.1`, and every request is
 *   additionally checked against the peer address, because a host-level proxy
 *   or a `--host 0.0.0.0` gateway on the same box must not be able to drive the
 *   launcher.
 * - **Shared bearer token.** The port is ephemeral and published in
 *   `run/control.json`, which any local process can read — so the file alone
 *   cannot be the authorization. The token is minted per boot and required on
 *   every request, which turns "any local process" into "any local process
 *   that already read a file the user's own account owns".
 * - **SSE for progress.** An update takes minutes and the tray wants a progress
 *   bar; polling `/status` at 10Hz for a percentage is worse in every way.
 */

/** Handshake file contents, shared with the tray host. */
export interface ControlHandshake {
  readonly port: number;
  readonly pid: number;
  readonly startedAt: number;
  readonly token: string;
}

/** Update state as the menu and tray see it. */
export interface UpdateSnapshot {
  readonly current: string;
  readonly latest: string;
  readonly available: boolean;
  /** Release notes for `latest`, when the feed carried a tag URL. */
  readonly notesUrl?: string;
  readonly publishedAt?: string;
}

/** Progress frame from the update engine, mirrored for the SSE stream. */
export interface UpdateProgressFrame {
  readonly phase: string;
  readonly percent: number;
  readonly message: string;
  readonly bytesReceived?: number;
  readonly bytesTotal?: number;
  readonly error?: string;
}

/**
 * Durable update state for `GET /update/state`.
 *
 * The launcher outlives the gateway child: an update stops the child, replaces
 * the binary, and starts it again. A console tab that reconnects after the
 * restart must still see the running flag and the last progress frame, so the
 * state lives in this process rather than in the gateway that was restarted.
 */
export interface UpdateStateFrame {
  readonly snapshot: UpdateSnapshot | null;
  readonly progress: UpdateProgressFrame | null;
  readonly running: boolean;
}

export type ControlEvent =
  | { readonly type: "status"; readonly status: ServerStatus }
  | { readonly type: "update"; readonly update: UpdateSnapshot | null }
  | { readonly type: "progress"; readonly progress: UpdateProgressFrame }
  | { readonly type: "shutdown" };

export interface ControlServerOptions {
  readonly installRoot: string;
  readonly supervisor: GatewaySupervisor;
  /** Console URL opened by `POST /open-web`. */
  readonly consoleUrl: string;
  /** Called for `POST /shutdown`; the launcher closes the server and exits. */
  readonly onShutdown: () => void;
  /** Called for `POST /tray/hide`. */
  readonly onTrayHide?: () => void;
  /** Starts the update flow; progress is published through `publishProgress`. */
  readonly startUpdate?: () => Promise<void>;
  /** Injected for tests; defaults to the platform browser opener. */
  readonly openBrowser?: (url: string) => void;
  readonly logLine?: (line: string) => void;
}

/** Header carrying the bearer token. */
export const CONTROL_TOKEN_HEADER = "x-lianrouter-control";

/** Loopback peers. `::1` and the v4-mapped form appear when the host resolves `localhost` to IPv6 first. */
const LOOPBACK_ADDRESSES: readonly string[] = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

export class ControlServer {
  private readonly options: ControlServerOptions;
  private server: ReturnType<typeof Bun.serve> | undefined;
  private readonly clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly encoder = new TextEncoder();
  private token = "";
  private unsubscribe: (() => void) | undefined;
  /**
   * Update state owned by this process, not by the gateway it supervises. The
   * gateway is stopped and started inside an update, so anything the console
   * wants to keep across that window has to live here.
   */
  private updateSnapshot: UpdateSnapshot | null = null;
  private updateProgress: UpdateProgressFrame | null = null;
  private updateRunning = false;

  constructor(options: ControlServerOptions) {
    this.options = options;
  }

  /** Bound port; throws if read before {@link start}. */
  get port(): number {
    const server = this.server;
    const port = server?.port;
    if (port === undefined) {
      throw new Error("control server is not listening");
    }
    return port;
  }

  /** Bearer token required by every request. */
  get controlToken(): string {
    return this.token;
  }

  async start(): Promise<ControlHandshake> {
    this.token = generateToken();
    const startedAt = Date.now();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => this.handle(request, server),
    });
    // `Server.port` is optional in the Bun types because a unix-socket server has
    // none. This one always binds TCP, so a missing port is a runtime bug worth
    // failing loudly on rather than publishing `undefined` in the handshake.
    const port = server.port;
    if (port === undefined) {
      server.stop(true);
      throw new Error("control server bound without a TCP port");
    }
    this.server = server;
    const handshake: ControlHandshake = {
      port,
      pid: process.pid,
      startedAt,
      token: this.token,
    };
    await this.writeHandshake(handshake);
    this.unsubscribe = this.options.supervisor.subscribe((status) => {
      this.publish({ type: "status", status });
    });
    return handshake;
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.publish({ type: "shutdown" });
    for (const controller of this.clients) {
      try {
        controller.close();
      } catch {
        // Already closed by the client; nothing to release.
      }
    }
    this.clients.clear();
    this.server?.stop(true);
    this.server = undefined;
    await this.removeHandshake();
  }

  /** Pushes one frame to every SSE client. */
  publish(event: ControlEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    const bytes = this.encoder.encode(payload);
    for (const controller of [...this.clients]) {
      try {
        controller.enqueue(bytes);
      } catch {
        this.clients.delete(controller);
      }
    }
  }

  /** Convenience for the update flow: broadcast a progress frame. */
  publishProgress(progress: UpdateProgressFrame): void {
    // Recorded before broadcasting: a console that reconnects after the gateway
    // restart reads `/update/state`, and the last frame it missed has to be
    // there. `done` is terminal, so the frame is dropped rather than left to
    // read as an in-flight update forever.
    this.updateProgress = progress.phase === "done" ? null : progress;
    this.publish({ type: "progress", progress });
  }

  /** Convenience for the update flow: broadcast a new update snapshot. */
  publishUpdate(update: UpdateSnapshot | null): void {
    this.updateSnapshot = update;
    this.publish({ type: "update", update });
  }

  /**
   * Marks the update flow as running or settled.
   *
   * Set by `POST /update/start`'s acceptor and cleared when the flow settles,
   * so a second start is refused with `409` instead of racing the install. It
   * is also what the console reads after a gateway restart to know that the
   * absence of progress frames means "still working", not "nothing happened".
   */
  setUpdateRunning(running: boolean): void {
    this.updateRunning = running;
  }

  /** Current update state; see {@link UpdateStateFrame}. */
  get updateState(): UpdateStateFrame {
    return {
      snapshot: this.updateSnapshot,
      progress: this.updateProgress,
      running: this.updateRunning,
    };
  }

  private async handle(
    request: Request,
    server: ReturnType<typeof Bun.serve>,
  ): Promise<Response> {
    const peer = server.requestIP(request)?.address;
    if (peer === undefined || !LOOPBACK_ADDRESSES.includes(peer)) {
      return json({ error: "control plane is loopback-only" }, 403);
    }
    if (request.headers.get(CONTROL_TOKEN_HEADER) !== this.token) {
      return json({ error: "missing or invalid control token" }, 401);
    }

    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method === "GET" && pathname === "/status") {
      return json({
        ...this.options.supervisor.status,
        update: this.updateSnapshot,
      });
    }
    if (method === "GET" && pathname === "/update/state") {
      return json(this.updateState);
    }
    if (method === "GET" && pathname === "/events") {
      return this.openEventStream();
    }
    if (method === "POST" && pathname === "/server/start") {
      return json(await this.options.supervisor.start());
    }
    if (method === "POST" && pathname === "/server/stop") {
      return json(await this.options.supervisor.stop());
    }
    if (method === "POST" && pathname === "/server/restart") {
      return json(await this.options.supervisor.restart());
    }
    if (method === "POST" && pathname === "/open-web") {
      this.openUrl(this.options.consoleUrl);
      return json({ ok: true, url: this.options.consoleUrl });
    }
    if (method === "POST" && pathname === "/tray/hide") {
      this.options.onTrayHide?.();
      return json({ ok: true });
    }
    if (method === "POST" && pathname === "/update/start") {
      const startUpdate = this.options.startUpdate;
      if (startUpdate === undefined) {
        return json({ error: "update flow is unavailable in this build" }, 501);
      }
      // A second start would race the install: both would stop the child, both
      // would replace the binary. The flag is set here rather than inside the
      // flow so the refusal window opens with the response.
      if (this.updateRunning) {
        return json({ error: "an update is already running" }, 409);
      }
      this.setUpdateRunning(true);
      // 202: the work outlives the request; progress arrives on /events.
      void startUpdate()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.publishProgress({ phase: "error", percent: 0, message });
        })
        .finally(() => {
          this.setUpdateRunning(false);
        });
      return json({ accepted: true }, 202);
    }
    if (method === "POST" && pathname === "/shutdown") {
      // Answer before tearing the socket down, otherwise the caller sees a
      // connection reset and cannot tell shutdown from a crash.
      setTimeout(() => {
        this.options.onShutdown();
      }, 10);
      return json({ ok: true });
    }

    return json({ error: `unknown route ${method} ${pathname}` }, 404);
  }

  private openEventStream(): Response {
    // The controller is captured so `cancel` can unregister the exact stream the
    // client dropped; `cancel` receives a reason, not the controller.
    let registered: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        registered = controller;
        this.clients.add(controller);
        controller.enqueue(
          this.encoder.encode(
            `data: ${JSON.stringify({ type: "status", status: this.options.supervisor.status })}\n\n`,
          ),
        );
        controller.enqueue(
          this.encoder.encode(
            `data: ${JSON.stringify({ type: "update", update: this.updateSnapshot })}\n\n`,
          ),
        );
      },
      cancel: () => {
        if (registered !== undefined) {
          this.clients.delete(registered);
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  private openUrl(url: string): void {
    const opener = this.options.openBrowser;
    if (opener !== undefined) {
      opener(url);
      return;
    }
    const command =
      process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : process.platform === "darwin"
          ? ["open", url]
          : ["xdg-open", url];
    try {
      const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      void child.exited;
    } catch {
      this.options.logLine?.(`could not open ${url}; open it manually`);
    }
  }

  /**
   * Writes the handshake atomically.
   *
   * The reader is a different process (the tray), so a plain write leaves a
   * window in which it sees a truncated file and reports a JSON parse error for
   * a handshake that is fine a millisecond later. Writing beside the target and
   * renaming closes that window: `rename` is atomic on both NTFS and POSIX, so a
   * reader sees either the previous file or the complete new one.
   */
  private async writeHandshake(handshake: ControlHandshake): Promise<void> {
    const file = resolveControlFile(this.options.installRoot);
    await mkdir(dirname(file), { recursive: true });
    const staging = `${file}.tmp`;
    // 0600: the token is the only thing standing between a local process and
    // the launcher, so the file must not be world-readable.
    await writeFile(staging, `${JSON.stringify(handshake, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(staging, file);
  }

  private async removeHandshake(): Promise<void> {
    try {
      await rm(resolveControlFile(this.options.installRoot), { force: true });
    } catch {
      return;
    }
  }
}

function json(body: unknown, status: number = 200): Response {
  return Response.json(body, { status });
}

/**
 * 128 bits from the platform CSPRNG, hex encoded. `crypto.randomUUID` would be
 * 122 bits of the same source with a fixed shape; the raw bytes are simpler to
 * compare and carry no version nibble to mistake for structure.
 */
function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
