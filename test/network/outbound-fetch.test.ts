import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { createValidatedFetch } from "../../src/network/outbound-fetch";
import { createHttpProxyAgent, ProxyConnectError } from "../../src/network/pool/agent";
import { metrics } from "../../src/observability/metrics";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function startHttpServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok-http1");
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function counterValue(name: string): number {
  const match = metrics.render().match(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, "m"));
  return match ? Number(match[1]) : 0;
}

const loopbackPolicy = { allowPrivate: true } as const;
const resolveLoopback = async (): Promise<readonly string[]> => ["127.0.0.1"];

describe("createValidatedFetch transport selection", () => {
  test("uses the pinned HTTP/1.1 path for a direct dial", async () => {
    const port = await startHttpServer();
    const fetchFn = createValidatedFetch({
      policy: loopbackPolicy,
      resolveFn: resolveLoopback,
    });
    const response = await fetchFn(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok-http1");
  });

  test("pool-bound dial still egresses when local target DNS fails (broken VPN resolver)", async () => {
    // A minimal CONNECT proxy: tunnels the caller's stream verbatim to the
    // requested host:port (the proxy resolves the target itself, never the
    // gateway's system resolver).
    const proxies: net.Server[] = [];
    const startConnectProxy = (): Promise<number> => {
      const { promise, resolve } = Promise.withResolvers<number>();
      const server = net.createServer((socket) => {
        socket.once("data", (first) => {
          const line = first.toString().split("\r\n")[0] ?? "";
          const match = /^CONNECT ([^:]+):(\d+) /.exec(line);
          if (!match) {
            socket.end();
            return;
          }
          /**
           * The CONNECT host is the target hostname (unresolvable locally by
           * design in this test). The proxy resolves its own answer — here the
           * origin server lives on loopback, so dial 127.0.0.1:port the same
           * way a real proxy would dial the address it resolved.
           */
          const upstream = net.connect(Number(match[2]), "127.0.0.1", () => {
            socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
            upstream.pipe(socket);
            socket.pipe(upstream);
          });
          upstream.on("error", () => socket.end());
        });
      });
      proxies.push(server);
      server.listen(0, "127.0.0.1", () =>
        resolve((server.address() as AddressInfo).port),
      );
      return promise;
    };
    try {
      const targetPort = await startHttpServer();
      const proxyPort = await startConnectProxy();
      const agent = createHttpProxyAgent(`http://127.0.0.1:${proxyPort}`, undefined, loopbackPolicy);
      const before = counterValue("lianrouter_proxy_dial_dns_fallback_total");

      // Broken-VPN DNS: the target hostname fails to resolve locally, but the
      // proxy address (127.0.0.1) resolves. The CONNECT proxy resolves the
      // target itself, so egress must still succeed.
      const failingResolve = async (hostname: string): Promise<readonly string[]> => {
        if (hostname === "127.0.0.1") return ["127.0.0.1"];
        throw new Error("upstream DNS resolution failed");
      };
      const fetchFn = createValidatedFetch({
        policy: loopbackPolicy,
        resolveFn: failingResolve,
        agent,
      });

      const response = await fetchFn(`http://target.invalid:${targetPort}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok-http1");
      expect(counterValue("lianrouter_proxy_dial_dns_fallback_total")).toBe(before + 1);
    } finally {
      for (const p of proxies.splice(0)) p.close();
    }
  });

  test("a loopback target bypasses the pool agent and dials the gateway host directly", async () => {
    // A remote CONNECT proxy dials from its own network, so `CONNECT 127.0.0.1:...`
    // would address the *proxy's* loopback. In-process bridges (e.g. the OpenCode
    // CLI bridge) live on the gateway host and must never be sent through a pool.
    const proxies: net.Server[] = [];
    const startConnectProxy = (): Promise<number> => {
      const { promise, resolve } = Promise.withResolvers<number>();
      const server = net.createServer((socket) => {
        socket.once("data", () => {
          // Any CONNECT reaching this proxy means the pool agent owned the
          // dial - the invariant under test. Answer 403 like a real proxy
          // rejecting a loopback destination.
          socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        });
      });
      proxies.push(server);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
      return promise;
    };
    try {
      const targetPort = await startHttpServer();
      const proxyPort = await startConnectProxy();
      const agent = createHttpProxyAgent(`http://127.0.0.1:${proxyPort}`, undefined, loopbackPolicy);
      const fetchFn = createValidatedFetch({
        policy: loopbackPolicy,
        resolveFn: resolveLoopback,
        agent,
      });

      const response = await fetchFn(`http://127.0.0.1:${targetPort}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok-http1");

      // Hostname form of the same guarantee.
      const byName = await fetchFn(`http://localhost:${targetPort}/`);
      expect(byName.status).toBe(200);
      expect(await byName.text()).toBe("ok-http1");

      // Non-local targets still take the proxy path (the pair stays active);
      // the fake proxy rejects every CONNECT, so the dial must surface the
      // proxy's 403 instead of silently dialing direct.
      let proxiedError: unknown;
      try {
        await fetchFn(`http://target.invalid:${targetPort}/`);
      } catch (error) {
        proxiedError = error;
      }
      if (!(proxiedError instanceof ProxyConnectError)) {
        throw new Error(`expected ProxyConnectError, got ${String(proxiedError)}`);
      }
      expect(proxiedError.proxyStatus).toBe(403);
    } finally {
      for (const p of proxies.splice(0)) p.close();
    }
  });

  test("a proxy that accepts CONNECT and never answers fails the dial instead of hanging", async () => {
    // A blackholed exit accepts the TCP connection and then says nothing. The
    // dispatch used to wait for the caller's deadline (measured at 35-120s in
    // production), and because no error was raised the pool was never flagged.
    const silent = net.createServer((socket) => {
      // Deliberately never answer the CONNECT line; hold the socket open.
      socket.on("error", () => undefined);
    });
    const silentServers: net.Server[] = [silent];
    const proxyPort = await new Promise<number>((resolve) => {
      silent.listen(0, "127.0.0.1", () => resolve((silent.address() as AddressInfo).port));
    });
    try {
      const agent = createHttpProxyAgent(`http://127.0.0.1:${proxyPort}`, undefined, loopbackPolicy);
      const fetchFn = createValidatedFetch({
        policy: loopbackPolicy,
        resolveFn: resolveLoopback,
        agent,
      });
      const startedAt = Date.now();
      let dialError: unknown;
      try {
        await fetchFn(`http://target.invalid:${proxyPort}/`);
      } catch (error) {
        dialError = error;
      }
      const elapsed = Date.now() - startedAt;
      expect(dialError).toBeInstanceOf(ProxyConnectError);
      expect((dialError as ProxyConnectError).proxyStatus).toBe(0);
      // Well under the 15s handshake bound, and nothing like the old hang.
      expect(elapsed).toBeLessThan(20_000);
    } finally {
      for (const server of silentServers) server.close();
    }
  });
});
