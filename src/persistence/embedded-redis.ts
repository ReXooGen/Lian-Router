/**
 * In-process Redis for `REDIS_MODE=embedded`.
 *
 * The gateway coordinates through Redis in twelve places: admission counters,
 * IP-abuse windows, model strikes, pool in-flight accounting, the quota cache,
 * OAuth flow state, and domain stats. Each of them is a `RedisClient`, so the
 * only honest way to run without a Redis server is a client that implements the
 * same command surface — not a set of per-consumer in-memory branches, which
 * would drift from the real path and rot the first time a script changed.
 *
 * `ioredis-mock` is that client. It parses and executes Lua `EVAL`, which is
 * what makes this viable at all: every atomic decision in this codebase is a
 * Lua script (compare-and-increment admission, sliding-window abuse, scripted
 * release). A key/value stand-in that could not run `EVAL` would silently turn
 * atomic operations into races.
 *
 * The trade this mode makes, stated where an operator will read it: state lives
 * in this process, so it does not survive a restart and it cannot coordinate a
 * second gateway process. Two processes each get their own counters and their
 * own view of a lease. `normal` mode exists for anything that needs more, and
 * the readiness report names this mode so the difference is never implicit.
 */

import RedisMock from "ioredis-mock";
import type { RedisClient } from "./redis";

/**
 * Builds the in-process client.
 *
 * Two things the mock does not provide that callers do read, and why each is
 * answered here rather than at the call site:
 *
 * - **`status`** — the Prometheus scrape reports `lianrouter_redis_up` from
 *   `redis.status === "ready"`, and ioredis' `status` is a connection
 *   lifecycle. An in-process client is always connected, so reporting
 *   `"ready"` is the accurate answer rather than a comforting one. Without it
 *   the metric would read 0 forever and an operator would chase a Redis outage
 *   that does not exist.
 * - **`error` events** — every consumer attaches a listener; the mock is an
 *   EventEmitter and accepts them, so no shim is needed there.
 *
 * The return type is the real `ioredis.Redis`, which is what `@types/ioredis-mock`
 * already declares, so the client composes with the stores without a cast.
 */
export function createEmbeddedRedis(): RedisClient {
  const client = new RedisMock();
  // `status` is a plain property on the ioredis client; the mock leaves it
  // undefined because it has no socket to report on.
  Object.defineProperty(client, "status", {
    value: "ready",
    writable: false,
    configurable: true,
    enumerable: true,
  });
  return client;
}
