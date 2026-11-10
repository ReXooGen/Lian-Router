import { describe, expect, test } from "bun:test";
import { usageRequestsUrl } from "./lib/hooks/system";
import { queryKeys } from "./lib/query-keys";
import {
  nextUsageRequestFilter,
  type UsageRequestFilter,
} from "./routes/usage-request-filters";

/**
 * The Requests card's access-scope dropdown maps "Shared access" to the
 * tri-state `shared` argument (`true`), and "All requests" to `undefined`.
 * These assertions pin the URL the hook builds for each choice.
 */
describe("Usage access-scope filter", () => {
  test("Shared access adds shared=true to the request URL", () => {
    const url = usageRequestsUrl("7d", 50, null, true);
    expect(url).toContain("&shared=true");
    expect(new URL(url, "http://localhost").searchParams.get("shared")).toBe("true");
  });

  test("All requests drops the shared parameter", () => {
    const url = usageRequestsUrl("7d", 50, null, undefined);
    expect(url).not.toContain("shared=");
    expect(new URL(url, "http://localhost").searchParams.has("shared")).toBe(false);
  });

  test("the scope composes with the HTTP status filter", () => {
    const url = usageRequestsUrl("24h", 100, 503, true);
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("httpStatus")).toBe("503");
    expect(params.get("shared")).toBe("true");
    expect(params.get("period")).toBe("24h");
    expect(params.get("limit")).toBe("100");
  });
});

describe("Usage shared-key narrowing", () => {
  test("a child key alone narrows to one recipient", () => {
    const url = usageRequestsUrl("7d", 50, null, true, "", "child-1");
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("shared")).toBe("true");
    expect(params.get("childKeyId")).toBe("child-1");
    expect(params.has("parentKeyId")).toBe(false);
  });

  test("a template alone narrows to one share template", () => {
    const url = usageRequestsUrl("7d", 50, null, true, "tpl-1", "");
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("parentKeyId")).toBe("tpl-1");
    expect(params.has("childKeyId")).toBe(false);
  });

  test("both ids are emitted when both are selected", () => {
    const url = usageRequestsUrl("7d", 50, null, true, "tpl-1", "child-1");
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("parentKeyId")).toBe("tpl-1");
    expect(params.get("childKeyId")).toBe("child-1");
  });

  test("an all-within-template selection emits neither id", () => {
    const url = usageRequestsUrl("7d", 50, null, true, "", "");
    expect(url).not.toContain("parentKeyId=");
    expect(url).not.toContain("childKeyId=");
  });

  test("the query cache separates each template and key selection", () => {
    const base = queryKeys.usageAnalytics.requests("7d", 50, null, true);
    const template = queryKeys.usageAnalytics.requests("7d", 50, null, true, "tpl-1");
    const child = queryKeys.usageAnalytics.requests("7d", 50, null, true, "tpl-1", "child-1");
    expect(template).not.toEqual(base);
    expect(child).not.toEqual(template);
    expect(child).toContain("child-1");
  });

  test("changing the template clears the child key", () => {
    const selected: UsageRequestFilter = {
      accessScope: "shared",
      parentKeyId: "tpl-1",
      childKeyId: "child-1",
    };
    expect(
      nextUsageRequestFilter(selected, { kind: "template", parentKeyId: "tpl-2" }),
    ).toEqual({ accessScope: "shared", parentKeyId: "tpl-2", childKeyId: "" });
  });

  test("returning to all requests clears the template and the key", () => {
    const selected: UsageRequestFilter = {
      accessScope: "shared",
      parentKeyId: "tpl-1",
      childKeyId: "child-1",
    };
    expect(nextUsageRequestFilter(selected, { kind: "scope", scope: "all" })).toEqual({
      accessScope: "all",
      parentKeyId: "",
      childKeyId: "",
    });
  });
});
