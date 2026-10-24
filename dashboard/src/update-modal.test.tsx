import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { UpdateStatus } from "./lib/contracts";

/**
 * `Dialog` renders through a portal, and the server renderer refuses portals.
 * Rendering the portal's children inline keeps the markup under test identical
 * to what the browser paints, without pulling in a DOM implementation.
 *
 * Both imports below are dynamic on purpose: `mock.module` only affects modules
 * imported after it runs, so the component and its API client must load after
 * their seams are replaced. A static import would bind the real modules first
 * and the mocks would never apply.
 */
const stubHead = { appendChild: () => undefined };
Object.defineProperty(globalThis, "document", {
  value: {
    nodeType: 9,
    body: { nodeType: 1 },
    head: stubHead,
    getElementsByTagName: () => [stubHead],
    createElement: () => ({
      style: {},
      setAttribute: () => undefined,
      appendChild: () => undefined,
    }),
    createTextNode: () => ({}),
  },
  configurable: true,
});

const actualReactDom = await import("react-dom");
const realCreatePortal = actualReactDom.createPortal;
mock.module("react-dom", () => ({
  ...actualReactDom,
  createPortal: (node: unknown) => node,
}));

/** The modal reports through toasts; the assertions here are about the wire
 * calls and the rendered states, so the toast surface is a no-op seam. */
const actualToast = await import("./lib/toast");
mock.module("./lib/toast", () => ({
  toast: { success: () => undefined, error: () => undefined, dismiss: () => undefined },
}));

const actualApi = await import("./lib/api");
const realConsoleRequest = actualApi.consoleRequest;
const requestCalls: Array<{ path: string; method: string }> = [];
mock.module("./lib/api", () => ({
  ...actualApi,
  consoleRequest: async (path: string, init?: RequestInit) => {
    requestCalls.push({ path, method: (init?.method ?? "GET").toUpperCase() });
    if (path === "/update/start") return { accepted: true };
    return await realConsoleRequest(path, init);
  },
}));

const { UpdateModal } = await import("./components/UpdateModal");
const { useStartUpdate } = await import("./lib/hooks/update");
const { queryKeys } = await import("./lib/query-keys");

const AVAILABLE: UpdateStatus = {
  launcher: true,
  current: "2.0.0",
  latest: "2.0.5",
  available: true,
  notesUrl: "https://github.com/lianrouter/releases/tag/v2.0.5",
  publishedAt: "2026-10-20T10:00:00Z",
  running: false,
  progress: null,
};

function statusWith(overrides: Partial<UpdateStatus>): UpdateStatus {
  return { ...AVAILABLE, ...overrides };
}

function render(status: UpdateStatus | undefined): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (status) client.setQueryData(queryKeys.update.status, status);
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(UpdateModal)),
  );
}

beforeEach(() => {
  requestCalls.length = 0;
});

/**
 * `mock.module` is process-wide in this runner, so every replaced seam is
 * re-registered with its real implementation on the way out. Without this the
 * next test file imports the stub and a delegating wrapper recurses into
 * itself.
 */
afterAll(() => {
  Reflect.deleteProperty(globalThis, "document");
  mock.module("react-dom", () => ({ ...actualReactDom, createPortal: realCreatePortal }));
  mock.module("./lib/toast", () => actualToast);
  mock.module("./lib/api", () => ({ ...actualApi, consoleRequest: realConsoleRequest }));
  mock.restore();
});

describe("update modal", () => {
  test("renders nothing when no update is available", () => {
    expect(render(statusWith({ available: false }))).toBe("");
  });

  test("offers the target version and the install action", () => {
    const markup = render(AVAILABLE);
    expect(markup).toContain("Update available");
    expect(markup).toContain("2.0.0");
    expect(markup).toContain("2.0.5");
    // Rendered through `toLocaleDateString`, so the order depends on the host
    // locale; the month and year are what the row has to show.
    expect(markup).toContain("Oct");
    expect(markup).toContain("2026");
    expect(markup).toContain("Release notes");
    expect(markup).toContain("Install update");
  });

  test("confirming posts to the start endpoint", async () => {
    let run: (() => Promise<unknown>) | undefined;
    function Probe(): null {
      const mutation = useStartUpdate();
      run = () => mutation.mutateAsync();
      return null;
    }
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
    if (!run) throw new Error("mutation was not captured");
    await run();
    expect(requestCalls).toContainEqual({ path: "/update/start", method: "POST" });
  });

  test("a gateway without the launcher points at the terminal and offers no action", () => {
    const markup = render(statusWith({ launcher: false }));
    expect(markup).toContain("lianrouter update");
    expect(markup).toContain("in the terminal");
    expect(markup).not.toContain("Install update");
    expect(markup).not.toContain("Later");
  });

  test("shows the phase, percent and transfer size while installing", () => {
    const markup = render(
      statusWith({
        running: true,
        progress: {
          phase: "downloading",
          percent: 42,
          message: "Fetching lianrouter 2.0.5",
          bytesReceived: 13_002_342,
          bytesTotal: 60_922_675,
          error: null,
        },
      }),
    );
    expect(markup).toContain("Installing update");
    expect(markup).toContain("Downloading");
    expect(markup).toContain("42%");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain("12.4 / 58.1 MB");
  });

  test("surfaces a launcher error frame as an alert with a retry", () => {
    const markup = render(
      statusWith({
        running: false,
        progress: {
          phase: "error",
          percent: 0,
          message: "install failed",
          bytesReceived: null,
          bytesTotal: null,
          error: "Checksum mismatch for lianrouter-2.0.5.zip",
        },
      }),
    );
    expect(markup).toContain("Update failed");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Checksum mismatch for lianrouter-2.0.5.zip");
    expect(markup).toContain("Retry");
  });
});
