import { beforeEach, describe, expect, test } from "bun:test";
import { createLiveRoutes } from "../../../src/console/domains/live";
import { resetInFlightForTests, incrementInFlight } from "../../../src/transport/request/inflight";
import { NetworkPoolSelector } from "../../../src/network/pool/selector";
import type { AccessDecision } from "../../../src/security/access-control";
import { publishUsageActivity } from "../../../src/observability/usage-activity";

const readerAccess: AccessDecision = {
  id: "test-session",
  tenantId: "tenant-1",
  scopes: ["dashboard:read"],
  admissionIdentity: "test-session",
};

function appWith(access: AccessDecision | undefined, selector?: NetworkPoolSelector) {
  return createLiveRoutes({ accessResolver: () => access, ...(selector ? { poolSelector: selector } : {}) });
}

describe("live in-flight routes", () => {
  beforeEach(() => resetInFlightForTests());

  test("snapshot returns the current count", async () => {
    incrementInFlight();
    incrementInFlight();
    const response = await appWith(readerAccess).handle(
      new Request("http://localhost/live/in-flight"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inFlight: 2 });
  });

  test("snapshot rejects unauthenticated callers", async () => {
    const response = await appWith(undefined).handle(
      new Request("http://localhost/live/in-flight"),
    );
    expect(response.status).toBe(401);
  });

  test("stream emits a count snapshot frame first", async () => {
    incrementInFlight();
    const response = await appWith(readerAccess).handle(
      new Request("http://localhost/live/in-flight/stream"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    expect(new TextDecoder().decode(first.value)).toContain(`event: count\ndata: {"inFlight":1}`);
  });

  test("stream rejects unauthenticated callers without opening a stream", async () => {
    const response = await appWith(undefined).handle(
      new Request("http://localhost/live/in-flight/stream"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("text/event-stream");
  });
});

describe("live pool usage routes", () => {
  test("snapshot returns per-pool inflight rows", async () => {
    const selector = new NetworkPoolSelector();
    const slot = selector.acquire("pool-a", 10);
    expect(slot.acquired).toBe(true);
    const response = await appWith(readerAccess, selector).handle(
      new Request("http://localhost/live/pools"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pools: [{ poolId: "pool-a", currentInflight: 1 }] });
    slot.release();
  });

  test("snapshot is empty when no pool is in use", async () => {
    const selector = new NetworkPoolSelector();
    const response = await appWith(readerAccess, selector).handle(
      new Request("http://localhost/live/pools"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pools: [] });
  });

  test("snapshot rejects unauthenticated callers", async () => {
    const response = await appWith(undefined, new NetworkPoolSelector()).handle(
      new Request("http://localhost/live/pools"),
    );
    expect(response.status).toBe(401);
  });

  test("stream emits a pools snapshot frame first", async () => {
    const selector = new NetworkPoolSelector();
    const slot = selector.acquire("pool-s", 10);
    expect(slot.acquired).toBe(true);
    const response = await appWith(readerAccess, selector).handle(
      new Request("http://localhost/live/pools/stream"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    slot.release();
    expect(new TextDecoder().decode(first.value)).toContain(
      `event: pools\ndata: {"pools":[{"poolId":"pool-s","currentInflight":1}]}`,
    );
  });

  test("stream rejects unauthenticated callers without opening a stream", async () => {
    const response = await appWith(undefined, new NetworkPoolSelector()).handle(
      new Request("http://localhost/live/pools/stream"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("text/event-stream");
  });

  test("selector subscription fires on acquire and release", async () => {
    const selector = new NetworkPoolSelector();
    const seen: Array<readonly { poolId: string; currentInflight: number }[]> = [];
    const stop = selector.subscribePoolUsage((usage) => seen.push(usage));
    const slot = selector.acquire("pool-sub", 10);
    slot.release();
    stop();
    // Release after unsubscribe emits nothing further.
    const extra = selector.acquire("pool-sub", 10);
    extra.release();
    expect(seen).toEqual([
      [{ poolId: "pool-sub", currentInflight: 1 }],
      [],
    ]);
  });
});

describe("live usage activity stream", () => {
  /** Opens the stream and returns a frame reader plus a cleanup. */
  async function openStream(access: AccessDecision | undefined) {
    const response = await appWith(access).handle(
      new Request("http://localhost/live/usage/stream"),
    );
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    /** Reads until `predicate` matches the buffered text, or gives up. */
    const readUntil = async (predicate: (text: string) => boolean): Promise<string> => {
      for (let i = 0; i < 20 && !predicate(buffer); i += 1) {
        const chunk = await reader!.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      return buffer;
    };
    return { response, readUntil, close: () => void reader!.cancel() };
  }

  test("opens with a ready frame naming the caller's tenant", async () => {
    const stream = await openStream(readerAccess);
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("content-type")).toBe("text/event-stream");
    const text = await stream.readUntil((t) => t.includes("event: ready"));
    expect(text).toContain(`event: ready\ndata: {"tenantId":"tenant-1"}`);
    stream.close();
  });

  test("rejects unauthenticated callers without opening a stream", async () => {
    const response = await appWith(undefined).handle(
      new Request("http://localhost/live/usage/stream"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("text/event-stream");
  });

  test("pushes the caller's own activity", async () => {
    const stream = await openStream(readerAccess);
    await stream.readUntil((t) => t.includes("event: ready"));
    publishUsageActivity([{ tenantId: "tenant-1" }]);
    const text = await stream.readUntil((t) => t.includes("event: usage"));
    expect(text).toContain('event: usage\ndata: {"count":1}');
    stream.close();
  });

  test("never delivers another tenant's activity", async () => {
    const stream = await openStream(readerAccess);
    await stream.readUntil((t) => t.includes("event: ready"));
    // The foreign batch carries a distinctive size so a leak is visible in the
    // frame payload, not just in the frame count.
    publishUsageActivity(
      Array.from({ length: 7 }, () => ({ tenantId: "tenant-other" })),
    );
    // A global write follows: it must still arrive, which proves the stream
    // stayed open and simply filtered rather than having closed on the foreign
    // event. Because the foreign publish happens first, a leak would put its
    // frame ahead of this one — so asserting on the first frame we read is
    // deterministic, not a race.
    publishUsageActivity([{ tenantId: null }]);
    const text = await stream.readUntil((t) => t.includes("event: usage"));
    expect(text).toContain('event: usage\ndata: {"count":1}');
    expect(text).not.toContain('{"count":7}');
    stream.close();
  });

  test("delivers a global write to every tenant", async () => {
    // `tenantId: null` can move shared rows that any tenant's aggregates read,
    // so it is broadcast rather than dropped.
    const stream = await openStream(readerAccess);
    await stream.readUntil((t) => t.includes("event: ready"));
    publishUsageActivity([{ tenantId: null }]);
    const text = await stream.readUntil((t) => t.includes("event: usage"));
    expect(text).toContain('event: usage\ndata: {"count":1}');
    stream.close();
  });
});
