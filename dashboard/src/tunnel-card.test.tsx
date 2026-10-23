import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import Overview from "./routes/Overview";
import { queryKeys } from "./lib/query-keys";

const TUNNEL_URL = "https://remainder-portsmouth-roman-sends.trycloudflare.com";
const LOCAL_ORIGIN = "http://127.0.0.1:12800";

/**
 * `Overview` builds its fallback base URL from `window.location.origin`, and
 * these render tests run without a DOM, so the one browser global it reads
 * during render is defined here.
 */
function installWindow(): void {
  Object.defineProperty(globalThis, "window", {
    value: { location: { origin: LOCAL_ORIGIN } },
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

function renderOverview(tunnel: {
  running: boolean;
  publicUrl: string | null;
  startedAt: string | null;
  error: string | null;
}): string {
  installWindow();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.tunnel.status, tunnel);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(Overview)),
    ),
  );
}

describe("gateway endpoint tunnel row", () => {
  test("advertises the tunnel host and marks the tunnel live while running", () => {
    const markup = renderOverview({
      running: true,
      publicUrl: TUNNEL_URL,
      startedAt: "2026-10-22T09:00:00.000Z",
      error: null,
    });

    expect(markup).toContain(`${TUNNEL_URL}/v1`);
    expect(markup).toContain(TUNNEL_URL);
    expect(markup).toContain("Live");
    expect(markup).not.toContain("Local only");
  });

  test("falls back to the same-origin URL and says the endpoint is local-only when off", () => {
    const markup = renderOverview({
      running: false,
      publicUrl: null,
      startedAt: null,
      error: null,
    });

    expect(markup).toContain(`${LOCAL_ORIGIN}/v1`);
    expect(markup).toContain("Off");
    expect(markup).toContain("Local only — reachable on this machine.");
    expect(markup).not.toContain("trycloudflare.com");
  });

  test("renders a recorded start failure inline as an alert", () => {
    const markup = renderOverview({
      running: false,
      publicUrl: null,
      startedAt: null,
      error: "Could not start cloudflared: Executable not found in $PATH",
    });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not start cloudflared");
  });
});
