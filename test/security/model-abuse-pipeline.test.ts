import { describe, expect, test } from "bun:test";
import { InMemoryModelAbuseStore, ModelStrikeService } from "../../src/security/model-abuse";
import type { ModelAbuseStore } from "../../src/security/model-abuse";
import { buildPipelineHarness } from "../helpers/pipeline-harness";

/**
 * The strike layer at its real seam.
 *
 * The middleware under test is the production one
 * (`createProxyRoutePreparationMiddleware`), mounted by the production pipeline
 * composition; only the preparer is a stub, and it rejects a named model with
 * the same `404 model_not_found` the real preparer throws for a name outside
 * the key's allowlist. So these assertions observe the production request path,
 * not a re-implementation of it.
 *
 * The last case is the invariant most likely to be "fixed" by a future reader:
 * a strike-store outage must not refuse a legitimate request. Admission is
 * fail-closed; this layer is fail-open on purpose.
 */

const route = "/v1/chat/completions";

function post(model: string): Request {
  return new Request(`http://lianrouter.test${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer harness-token",
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

function strikes(options: { threshold?: number; windowMs?: number; banTtlMs?: number } = {}) {
  let now = 1_000_000;
  const store = new InMemoryModelAbuseStore({ clock: () => now });
  const service = new ModelStrikeService(store, {
    threshold: options.threshold ?? 3,
    windowMs: options.windowMs ?? 60_000,
    banTtlMs: options.banTtlMs ?? 10_000,
  });
  return {
    service,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("model-abuse strikes at the preparation seam", () => {
  test("invalid-model rejections escalate, warn, then ban the client address", async () => {
    const { service } = strikes({ threshold: 3 });
    const harness = buildPipelineHarness({
      modelStrikes: service,
      invalidModels: ["not-a-model"],
    });

    const first = await harness.app.handle(post("not-a-model"));
    expect(first.status).toBe(404);
    const firstBody = (await first.json()) as { error: { code: string; message: string } };
    expect(firstBody.error.code).toBe("model_not_found");
    expect(firstBody.error.message).toContain("Warning 1/3");
    expect(harness.dispatchCounter.count).toBe(0);

    const second = await harness.app.handle(post("not-a-model"));
    expect(second.status).toBe(404);
    const secondBody = (await second.json()) as { error: { message: string } };
    expect(secondBody.error.message).toContain("Warning 2/3");

    // The third crossing attempt is refused as a ban, not as another 404: the
    // caller has used up the allowance, and the message changes shape.
    const third = await harness.app.handle(post("not-a-model"));
    expect(third.status).toBe(403);
    const thirdBody = (await third.json()) as { error: { code: string } };
    expect(thirdBody.error.code).toBe("model_abuse_banned");

    // A banned address is refused before preparation, so even a *valid* model
    // no longer reaches dispatch from it.
    const validWhileBanned = await harness.app.handle(post("good-model"));
    expect(validWhileBanned.status).toBe(403);
    expect(harness.dispatchCounter.count).toBe(0);
  });

  test("a valid model request still dispatches and resets nothing", async () => {
    const { service } = strikes({ threshold: 3 });
    const harness = buildPipelineHarness({
      modelStrikes: service,
      invalidModels: ["not-a-model"],
    });

    await harness.app.handle(post("not-a-model"));
    const valid = await harness.app.handle(post("good-model"));
    expect(valid.status).toBe(200);
    expect(harness.dispatchCounter.count).toBe(1);

    // The window kept the earlier strike: the next two invalid attempts still
    // reach the threshold instead of starting over.
    await harness.app.handle(post("not-a-model"));
    const crossing = await harness.app.handle(post("not-a-model"));
    expect(crossing.status).toBe(403);
  });

  test("a lapsed ban lets the address back in", async () => {
    const { service, advance } = strikes({ threshold: 2, banTtlMs: 10_000 });
    const harness = buildPipelineHarness({
      modelStrikes: service,
      invalidModels: ["not-a-model"],
    });

    await harness.app.handle(post("not-a-model"));
    const banned = await harness.app.handle(post("not-a-model"));
    expect(banned.status).toBe(403);

    advance(10_001);
    const afterLapse = await harness.app.handle(post("good-model"));
    expect(afterLapse.status).toBe(200);
    expect(harness.dispatchCounter.count).toBe(1);
  });

  test("a strike-store outage never blocks a request (fail-open)", async () => {
    // A store that is unreachable for every operation. The real Redis store
    // behaves this way when the connection drops: every call rejects.
    const outage: ModelAbuseStore = {
      record: () => Promise.reject(new Error("redis unreachable")),
      isBanned: () => Promise.reject(new Error("redis unreachable")),
      listBans: () => Promise.resolve([]),
      unban: () => Promise.resolve(false),
      ban: () => Promise.reject(new Error("redis unreachable")),
    };
    const harness = buildPipelineHarness({
      modelStrikes: new ModelStrikeService(outage, { threshold: 1 }),
      invalidModels: ["not-a-model"],
    });

    // The ban lookup fails, the strike write fails, and the request still gets
    // the answer it would have received with no strike layer at all: a plain
    // 404, not a 403 and not a 503.
    const invalid = await harness.app.handle(post("not-a-model"));
    expect(invalid.status).toBe(404);
    const body = (await invalid.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.message).not.toContain("Warning");

    const valid = await harness.app.handle(post("good-model"));
    expect(valid.status).toBe(200);
    expect(harness.dispatchCounter.count).toBe(1);
  });
});
