import { afterEach, describe, expect, test } from "bun:test";
import { ConsoleDomainError } from "../../../src/console/shared/errors";
import {
  TunnelService,
  type TunnelChildProcess,
  type TunnelSpawn,
} from "../../../src/console/tunnel/service";
import {
  getRuntimePublicBaseUrl,
  setRuntimePublicBaseUrl,
} from "../../../src/runtime/public-base-url";

const TUNNEL_HOST = "https://remainder-portsmouth-roman-sends.trycloudflare.com";
const TARGET = "http://127.0.0.1:12800";

/** A spawn double: controllable stderr, controllable exit, counted kills. */
class FakeChild implements TunnelChildProcess {
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  killCount = 0;
  private readonly exit = Promise.withResolvers<number>();
  private readonly encoder = new TextEncoder();
  private emitChunk: ((chunk: Uint8Array) => void) | null = null;
  private closeStderr: (() => void) | null = null;
  private exitedAlready = false;

  constructor() {
    this.exited = this.exit.promise;
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.emitChunk = (chunk) => controller.enqueue(chunk);
        this.closeStderr = () => controller.close();
      },
    });
  }

  emit(text: string): void {
    this.emitChunk?.(this.encoder.encode(text));
  }

  finish(code: number): void {
    if (this.exitedAlready) return;
    this.exitedAlready = true;
    this.closeStderr?.();
    this.exit.resolve(code);
  }

  kill(): void {
    this.killCount += 1;
    this.finish(143);
  }
}

interface Harness {
  readonly service: TunnelService;
  readonly children: FakeChild[];
  spawnCount(): number;
}

/** Services built by a test, so each one's process exit hook is released. */
const created: TunnelService[] = [];

function harness(options: { startTimeoutMs?: number } = {}): Harness {
  const children: FakeChild[] = [];
  const spawn: TunnelSpawn = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const service = new TunnelService({
    spawn,
    binary: "cloudflared",
    targetUrl: TARGET,
    startTimeoutMs: options.startTimeoutMs ?? 2_000,
  });
  created.push(service);
  return { service, children, spawnCount: () => children.length };
}

afterEach(() => {
  for (const service of created.splice(0)) service.dispose();
  setRuntimePublicBaseUrl(null);
});

describe("tunnel service start", () => {
  test("parses the public host out of cloudflared stderr", async () => {
    const { service, children } = harness();
    const started = service.start();

    children[0]?.emit("INF Requesting new quick Tunnel on trycloudflare.com...\n");
    children[0]?.emit(`INF |  ${TUNNEL_HOST}  |\n`);
    const status = await started;

    expect(status.running).toBe(true);
    expect(status.publicUrl).toBe(TUNNEL_HOST);
    expect(status.error).toBeNull();
    expect(status.startedAt).not.toBeNull();
    expect(getRuntimePublicBaseUrl()).toBe(TUNNEL_HOST);
  });

  test("ignores the quick-tunnel API host cloudflared prints on failure", async () => {
    const { service, children } = harness();
    const started = service.start();
    children[0]?.emit(
      'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded\n',
    );
    children[0]?.emit(`INF |  ${TUNNEL_HOST}  |\n`);

    const status = await started;

    expect(status.publicUrl).toBe(TUNNEL_HOST);
  });

  test("a failed quick-tunnel request is reported as a timeout, not as a host", async () => {
    const { service, children } = harness({ startTimeoutMs: 10 });
    const started = service.start();
    children[0]?.emit(
      'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded\n',
    );

    const error: unknown = await started.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConsoleDomainError);
    expect((error as ConsoleDomainError).code).toBe("tunnel_timeout");
    expect(service.status().publicUrl).toBeNull();
    expect(getRuntimePublicBaseUrl()).toBeNull();
  });

  test("spawns with an argument array, never a shell string", async () => {
    const commands: string[][] = [];
    const child = new FakeChild();
    const service = new TunnelService({
      spawn: (command) => {
        commands.push([...command]);
        return child;
      },
      binary: "cloudflared",
      targetUrl: TARGET,
    });
    created.push(service);

    const started = service.start();
    child.emit(`INF |  ${TUNNEL_HOST}  |\n`);
    await started;

    expect(commands).toEqual([
      ["cloudflared", "tunnel", "--url", TARGET, "--no-autoupdate"],
    ]);
  });

  test("is idempotent: a second start reuses the running tunnel and concurrent starts share one spawn", async () => {
    const { service, children, spawnCount } = harness();

    const first = service.start();
    const second = service.start();
    children[0]?.emit(`INF |  ${TUNNEL_HOST}  |\n`);

    const [a, b] = await Promise.all([first, second]);
    expect(a.publicUrl).toBe(TUNNEL_HOST);
    expect(b.publicUrl).toBe(TUNNEL_HOST);
    expect(spawnCount()).toBe(1);

    const again = await service.start();
    expect(again.publicUrl).toBe(TUNNEL_HOST);
    expect(spawnCount()).toBe(1);
  });

  test("a missing binary surfaces a typed 502 instead of the raw spawn error", async () => {
    const service = new TunnelService({
      spawn: () => {
        throw new Error('Executable not found in $PATH: "cloudflared"');
      },
      binary: "cloudflared",
      targetUrl: TARGET,
    });
    created.push(service);

    const error: unknown = await service.start().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConsoleDomainError);
    const domain = error as ConsoleDomainError;
    expect(domain.code).toBe("tunnel_unavailable");
    expect(domain.status).toBe(502);
    expect(domain.message).toContain("Could not start cloudflared");
    expect(domain.message).toContain("Executable not found");
    expect(service.status().running).toBe(false);
    expect(service.status().publicUrl).toBeNull();
    expect(service.status().error).toContain("Could not start cloudflared");
    expect(getRuntimePublicBaseUrl()).toBeNull();
  });

  test("reports the exit code when the child dies before publishing a host", async () => {
    const { service, children } = harness();
    const started = service.start();
    children[0]?.finish(1);

    const error: unknown = await started.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConsoleDomainError);
    expect((error as ConsoleDomainError).code).toBe("tunnel_unavailable");
    expect((error as ConsoleDomainError).message).toContain("code 1");
    expect(service.status().running).toBe(false);
    expect(getRuntimePublicBaseUrl()).toBeNull();
  });

  test("kills the child and reports a timeout when no host appears", async () => {
    const { service, children } = harness({ startTimeoutMs: 10 });
    const started = service.start();
    children[0]?.emit("INF Requesting new quick Tunnel on trycloudflare.com...\n");

    const error: unknown = await started.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConsoleDomainError);
    expect((error as ConsoleDomainError).code).toBe("tunnel_timeout");
    expect(children[0]?.killCount).toBe(1);
    expect(service.status().running).toBe(false);
    expect(getRuntimePublicBaseUrl()).toBeNull();
  });
});

describe("tunnel service stop", () => {
  test("clears the advertised host, the override, and kills the child", async () => {
    const { service, children } = harness();
    const started = service.start();
    children[0]?.emit(`INF |  ${TUNNEL_HOST}  |\n`);
    await started;

    const stopped = await service.stop();

    expect(stopped).toEqual({ running: false, publicUrl: null, startedAt: null, error: null });
    expect(getRuntimePublicBaseUrl()).toBeNull();
    expect(children[0]?.killCount).toBe(1);
  });

  test("is idempotent and does not kill a child twice", async () => {
    const { service, children } = harness();
    const started = service.start();
    children[0]?.emit(`INF |  ${TUNNEL_HOST}  |\n`);
    await started;

    await service.stop();
    const second = await service.stop();

    expect(second.running).toBe(false);
    expect(children[0]?.killCount).toBe(1);
  });

  test("a stop during the handshake wins instead of surfacing a start failure", async () => {
    const { service, children } = harness();
    const started = service.start();

    const stopped = await service.stop();
    const startResult = await started;

    expect(stopped.running).toBe(false);
    expect(startResult.running).toBe(false);
    expect(startResult.error).toBeNull();
    expect(children[0]?.killCount).toBe(1);
    expect(getRuntimePublicBaseUrl()).toBeNull();
  });

  test("stopping a tunnel that was never started is a no-op status read", async () => {
    const { service, spawnCount } = harness();

    expect(await service.stop()).toEqual({
      running: false,
      publicUrl: null,
      startedAt: null,
      error: null,
    });
    expect(spawnCount()).toBe(0);
  });
});

describe("tunnel service crash handling", () => {
  test("an unexpected exit flips running to false and drops the override", async () => {
    const { service, children } = harness();
    const started = service.start();
    children[0]?.emit(`INF |  ${TUNNEL_HOST}  |\n`);
    await started;
    expect(service.status().running).toBe(true);

    children[0]?.finish(1);
    // The service subscribes to `exited` before the test awaits it, so its
    // handler has already run when this resolves.
    await children[0]?.exited;

    const status = service.status();
    expect(status.running).toBe(false);
    expect(status.publicUrl).toBeNull();
    expect(status.error).toContain("code 1");
    expect(getRuntimePublicBaseUrl()).toBeNull();
  });

  test("a deliberate stop is not reported as a crash", async () => {
    const { service, children } = harness();
    const started = service.start();
    children[0]?.emit(`INF |  ${TUNNEL_HOST}  |\n`);
    await started;

    await service.stop();
    await children[0]?.exited;

    expect(service.status().error).toBeNull();
  });
});
