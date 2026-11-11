import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  VERSION_SOURCES,
  _resetOpenCodeVersion,
  getOpenCodeVersion,
  resolveOpenCodeVersion,
} from "../../../src/providers/operations/client-versions";
import {
  buildOpenCodeFreeHeaders,
  buildOpenCodeHeaders,
  generateOpenCodeRequestId,
  generateOpenCodeSessionId,
} from "../../../src/providers/integrations/opencode-fingerprint";
import { LIANROUTER_PROBE_MARKER } from "../../../src/providers/provider-registry";
import { dispatchContext } from "../../helpers/provider-dispatch";
import { jsonResponse } from "../../helpers/sse-fixtures";


describe("OpenCode version and fingerprinting", () => {
  beforeEach(() => {
    _resetOpenCodeVersion();
  });

  afterEach(() => {
    _resetOpenCodeVersion();
  });

  test("generates session ID matching OpenCode binary format (30 chars)", () => {
    const id = generateOpenCodeSessionId();
    expect(id.startsWith("ses_")).toBe(true);
    expect(id.length).toBe(30);
    // ses_ + 12 hex chars + 14 base62 chars
    expect(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id)).toBe(true);
  });

  test("generates unique session IDs on sequential calls", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateOpenCodeSessionId()));
    expect(ids.size).toBe(10);
  });

  test("generates request ID starting with msg_", () => {
    const reqId = generateOpenCodeRequestId();
    expect(reqId.startsWith("msg_")).toBe(true);
  });

  test("builds headers matching official CLI fingerprint", () => {
    _resetOpenCodeVersion(VERSION_SOURCES.opencode.fallback);
    const headers = buildOpenCodeHeaders();
    expect(headers["x-opencode-client"]).toBe("desktop");
    expect(headers["x-opencode-project"]).toBe("global");
    expect(headers["x-opencode-session"]?.startsWith("ses_")).toBe(true);
    expect(headers["x-opencode-session"]?.length).toBe(30);
    expect(headers["x-opencode-request"]?.startsWith("msg_")).toBe(true);
    // The CLI's four-segment shape: opencode/<channel>/<version>/<name>.
    expect(headers["user-agent"]).toBe(
      `opencode/latest/${VERSION_SOURCES.opencode.fallback}/cli`,
    );
    // The session identity travels under every alias the gate reads.
    expect(headers["x-session-affinity"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"]);
  });

  test("resolves version from npm registry", async () => {
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).includes("registry.npmjs.org")
        ? jsonResponse({ version: "1.19.0" })
        : new Response("missing", { status: 404 })) as unknown as typeof fetch;

    await resolveOpenCodeVersion(fetcher);
    expect(getOpenCodeVersion()).toBe("1.19.0");
    const headers = buildOpenCodeHeaders();
    expect(headers["user-agent"]).toBe("opencode/latest/1.19.0/cli");
  });

  test("keeps fallback on network failure", async () => {
    const fetcher = (async () => {
      throw new Error("network error");
    }) as unknown as typeof fetch;

    await resolveOpenCodeVersion(fetcher);
    expect(getOpenCodeVersion()).toBe(VERSION_SOURCES.opencode.fallback);
  });
});

describe("OpenCode Free bridge probe header", () => {
  const BASE_URL_ENV = "LIANROUTER_OPENCODEFT_BASE_URL";

  test("stamps x-bridge-probe only when a probe runs against a bridge origin", () => {
    const previous = process.env[BASE_URL_ENV];
    try {
      // Bridge configured + probe context: the bridge is the only origin that
      // can honour the marker, so it must be stamped with the literal "1".
      process.env[BASE_URL_ENV] = "http://127.0.0.1:8910";
      expect(
        buildOpenCodeFreeHeaders({ ...dispatchContext("opencodeft"), probe_marker: LIANROUTER_PROBE_MARKER })[
          "x-bridge-probe"
        ],
      ).toBe("1");

      // Bridge absent: a direct origin must never see the header.
      delete process.env[BASE_URL_ENV];
      expect(
        buildOpenCodeFreeHeaders({ ...dispatchContext("opencodeft"), probe_marker: LIANROUTER_PROBE_MARKER })[
          "x-bridge-probe"
        ],
      ).toBeUndefined();

      // Non-probe dispatch against a bridge: no marker in the context, no header.
      process.env[BASE_URL_ENV] = "http://127.0.0.1:8910";
      expect(buildOpenCodeFreeHeaders(dispatchContext("opencodeft"))["x-bridge-probe"]).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[BASE_URL_ENV];
      else process.env[BASE_URL_ENV] = previous;
    }
  });
});
