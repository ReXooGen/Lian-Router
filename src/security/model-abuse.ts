/**
 * Model-abuse strikes: a graduated response to a client that keeps asking for
 * a model it may not use.
 *
 * A gateway request names a model. When that name falls outside the key's
 * allowlist, hits a denylist entry, or resolves to nothing, preparation
 * rejects it as `404 model_not_found`. One such rejection is a client
 * mistake, and answering it plainly is correct. A hundred of them is not a
 * mistake: it is a probe, and it costs the operator real work — every attempt
 * becomes a failed row in the console and the usage view, burying the traffic
 * that matters.
 *
 * So the rejection escalates. Each invalid-model attempt inside a sliding
 * window records an instant against the caller's client address; crossing the
 * threshold bans that address. A valid request does not reset the window, and
 * instants older than the window stop counting, so a week-old probe cannot
 * combine with today's typo to ban anyone.
 *
 * **The ban is keyed on the client address alone.** Keying it on the API key
 * as well was the wrong trade: a key is shared by everyone behind a share link
 * or a team, so banning the key punishes callers that did nothing while the
 * address that actually probed mints a fresh key and continues. The address is
 * the identity that cannot be re-enrolled, which is the point of the
 * escalation.
 *
 * **A ban lapses on its own** after {@link DEFAULT_BAN_TTL_MS} rather than
 * staying until an operator lifts it, so a false positive (a shared NAT, a
 * client that genuinely mistyped a model id) heals without human
 * intervention. The console can still lift one early.
 *
 * **Fail-open on store outage — deliberately, and unlike admission.** The
 * admission layer refuses when its store is unreachable, because admitting an
 * unauthorized request costs more than refusing a valid one. This layer is the
 * inverse: a strike counter that cannot be read must not refuse a legitimate
 * request. A store error is swallowed and the request proceeds; the worst case
 * is a missed strike, never a blocked client. The asymmetry is intentional, so
 * do not "fix" this to fail closed without also arguing why a Redis blip
 * should take the data plane down.
 */
import { GatewayError } from "../transport/gateway-error";
import { redisEvalTuple, type RedisClient } from "../persistence/redis";

/** Invalid-model attempts inside the window that trip a ban. */
const DEFAULT_THRESHOLD = 10;
/** Window (ms) an invalid attempt stays countable. */
const DEFAULT_WINDOW_MS = 30 * 60_000;
/** How long (ms) a ban lasts before it lapses on its own. */
const DEFAULT_BAN_TTL_MS = 6 * 60 * 60_000;

/** A ban row, as the console reads it. */
export interface ModelAbuseBan {
  /** The client address the ban is keyed on. */
  readonly ip: string;
  /** Policy that triggered this address-wide ban. */
  readonly reason: "repeated_invalid_model_requests";
  /** Epoch ms the ban lapses on its own. */
  readonly expiresAt: number;
}

/** One strike decision, as the store sees it. */
export interface ModelAbuseAttempt {
  readonly ip: string;
  /** Whether this attempt named a model the key may use. */
  readonly valid: boolean;
  /** Invalid attempts inside the window that trip a ban. */
  readonly threshold: number;
  /** Sliding window (ms) that keeps an invalid attempt countable. */
  readonly windowMs: number;
  /** How long (ms) a ban lasts before it lapses on its own. */
  readonly banTtlMs: number;
}

/** What one strike decision decided. */
export interface ModelAbuseOutcome {
  /** The address is banned, now or already. */
  readonly banned: boolean;
  /** Invalid attempts still inside the window after this one. `0` when valid. */
  readonly strikes: number;
  /** This attempt crossed the threshold and recorded the ban. */
  readonly bannedNow: boolean;
}

/**
 * Decodes the `{banned, strikes, bannedNow}` tuple the strike script returns.
 *
 * The script is the only producer, so a value of the wrong length or with a
 * non-finite member means the script and its caller drifted (a desynced
 * deployment, a cluster resharding mid-eval). Reading that as a decision would
 * ban or admit on garbage, so it throws. The caller swallows the throw: on
 * this layer an unreadable counter is a missed strike, not a refusal.
 */
function decodeOutcome(raw: readonly unknown[]): ModelAbuseOutcome {
  if (raw.length !== 3) {
    throw new Error(`[model-abuse] strike script returned ${raw.length} elements, expected 3`);
  }
  const [bannedRaw, strikesRaw, bannedNowRaw] = raw.map((value) => Number(value));
  const banned = bannedRaw ?? NaN;
  const strikes = strikesRaw ?? NaN;
  const bannedNow = bannedNowRaw ?? NaN;
  if (!Number.isFinite(banned) || !Number.isFinite(strikes) || !Number.isFinite(bannedNow)) {
    throw new Error(`[model-abuse] strike script returned a non-finite value: ${String(raw)}`);
  }
  return { banned: banned === 1 || bannedNow === 1, strikes, bannedNow: bannedNow === 1 };
}

export interface ModelAbuseStore {
  /**
   * One atomic strike decision: read the ban, and when the attempt is invalid,
   * record it in the address's sliding window and ban on the crossing attempt.
   * A valid attempt changes nothing.
   *
   * One method rather than four because the Redis store pays a round trip per
   * call, and this runs on the prepare path of every `/v1/*` model request.
   */
  record(attempt: ModelAbuseAttempt): Promise<ModelAbuseOutcome>;
  /** Ban lookup for the pre-prepare gate. */
  isBanned(ip: string): Promise<boolean>;
  /** Every active ban, for the console. */
  listBans(): Promise<readonly ModelAbuseBan[]>;
  /** Lifts one ban. Returns whether a ban existed. */
  unban(ip: string): Promise<boolean>;
  /**
   * Bans one address immediately for `ttlMs`, regardless of strike history,
   * and returns the expiry (epoch ms). The operator's instant-ban action and
   * the graduated strike path share one ban set, so `unban` lifts both.
   */
  ban(ip: string, ttlMs: number): Promise<number>;
}

export interface InMemoryModelAbuseStoreOptions {
  readonly clock?: () => number;
  /** Distinct addresses tracked before the oldest is evicted. */
  readonly maxKeys?: number;
}

/**
 * In-memory strike store: one instant list per address and one ban map.
 *
 * Each invalid attempt keeps its own instant, so the count is "how many are
 * still inside the window" rather than a counter that must be reset. A valid
 * request therefore cannot clear it, and an old attempt leaves on its own.
 * Bans are swept lazily on the next read of that address instead of scanning
 * the map per request. Both maps are bounded: the strike map by `maxKeys`
 * (oldest evicted) so a fan-out over unique addresses cannot pin memory, and
 * the ban map by the abuse itself, since every entry cost a full threshold of
 * attempts.
 */
export class InMemoryModelAbuseStore implements ModelAbuseStore {
  private readonly strikes = new Map<string, number[]>();
  private readonly bans = new Map<string, number>();
  private readonly clock: () => number;
  private readonly maxKeys: number;

  constructor(options: InMemoryModelAbuseStoreOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /** Evicts the oldest entries in one pass down to `maxKeys`. */
  private evictOldest(): void {
    if (this.strikes.size < this.maxKeys) return;
    let toEvict = this.strikes.size - this.maxKeys + 1;
    for (const key of this.strikes.keys()) {
      if (toEvict-- <= 0) break;
      this.strikes.delete(key);
    }
  }

  /** The live ban's expiry, or `undefined`; an elapsed ban is dropped. */
  private banExpiry(ip: string, now: number): number | undefined {
    const expiresAt = this.bans.get(ip);
    if (expiresAt === undefined) return undefined;
    if (expiresAt <= now) {
      this.bans.delete(ip);
      return undefined;
    }
    return expiresAt;
  }

  /** Drops instants older than the window in place and returns the live list. */
  private liveAttempts(ip: string, now: number, windowMs: number): number[] {
    const cutoff = now - windowMs;
    const existing = this.strikes.get(ip) ?? [];
    let write = 0;
    for (let read = 0; read < existing.length; read += 1) {
      const instant = existing[read];
      if (instant !== undefined && instant > cutoff) {
        existing[write] = instant;
        write += 1;
      }
    }
    existing.length = write;
    if (existing.length === 0) this.strikes.delete(ip);
    else this.strikes.set(ip, existing);
    return existing;
  }

  async record(attempt: ModelAbuseAttempt): Promise<ModelAbuseOutcome> {
    const now = this.clock();
    const { ip, valid, threshold, windowMs, banTtlMs } = attempt;

    // The ban is read first and short-circuits: a banned address records
    // nothing, so it can neither extend its own window nor defer the ban it
    // already earned.
    if (this.banExpiry(ip, now) !== undefined)
      return { banned: true, strikes: 0, bannedNow: false };

    if (valid) return { banned: false, strikes: 0, bannedNow: false };

    const live = this.liveAttempts(ip, now, windowMs);
    live.push(now);
    this.evictOldest();
    this.strikes.set(ip, live);
    if (live.length >= threshold) {
      this.bans.set(ip, now + banTtlMs);
      // The window's work is done: the ban is the record now, and keeping the
      // instants would let a stale list survive into the post-ban window.
      this.strikes.delete(ip);
      return { banned: true, strikes: live.length, bannedNow: true };
    }
    return { banned: false, strikes: live.length, bannedNow: false };
  }

  async listBans(): Promise<readonly ModelAbuseBan[]> {
    const now = this.clock();
    const bans: ModelAbuseBan[] = [];
    for (const [ip, expiresAt] of [...this.bans]) {
      if (expiresAt <= now) this.bans.delete(ip);
      else bans.push({ ip, reason: "repeated_invalid_model_requests", expiresAt });
    }
    return bans;
  }

  async isBanned(ip: string): Promise<boolean> {
    return this.banExpiry(ip, this.clock()) !== undefined;
  }

  async unban(ip: string): Promise<boolean> {
    return this.bans.delete(ip);
  }

  async ban(ip: string, ttlMs: number): Promise<number> {
    const expiresAt = this.clock() + Math.max(1, ttlMs);
    this.bans.set(ip, expiresAt);
    return expiresAt;
  }
}

/**
 * The one strike decision, as a static Lua script.
 *
 * `KEYS[1]` the address's attempt sorted set, `KEYS[2]` the ban index.
 * `ARGV`: 1 valid(`1`/`0`), 2 windowMs, 3 ip, 4 now (epoch ms), 5 threshold,
 * 6 banTtlMs.
 *
 * Returns `{banned, strikes, bannedNow}`. The ban is read first and
 * short-circuits without writing, so a banned address cannot extend its own
 * window. Every invalid attempt is its own member scored by its instant, with
 * a per-key sequence in the member name so two attempts inside the same
 * millisecond cannot collapse into one and undercount. Members older than the
 * window are removed before the count, so a valid request does not reset it
 * and an old attempt leaves on its own. The ban index is a sorted set scored
 * with each ban's expiry, so an expired ban needs no sweeper. `now` comes from
 * the caller's clock rather than the server's so the in-memory and Redis
 * stores age a ban identically.
 */
const MODEL_ABUSE_SCRIPT = `
  local score = redis.call('ZSCORE', KEYS[2], ARGV[3])
  if score then
    if tonumber(score) > tonumber(ARGV[4]) then
      return {1, 0, 0}
    end
    redis.call('ZREM', KEYS[2], ARGV[3])
  end
  if ARGV[1] == '1' then
    return {0, 0, 0}
  end
  local now = tonumber(ARGV[4])
  local windowMs = tonumber(ARGV[2])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)
  local seq = redis.call('INCR', KEYS[1] .. ':seq')
  redis.call('ZADD', KEYS[1], now, now .. ':' .. seq)
  local count = redis.call('ZCARD', KEYS[1])
  redis.call('PEXPIRE', KEYS[1], windowMs)
  redis.call('PEXPIRE', KEYS[1] .. ':seq', windowMs)
  if count >= tonumber(ARGV[5]) then
    redis.call('ZADD', KEYS[2], now + tonumber(ARGV[6]), ARGV[3])
    redis.call('DEL', KEYS[1], KEYS[1] .. ':seq')
    return {0, count, 1}
  end
  return {0, count, 0}
`;

export class RedisModelAbuseStore implements ModelAbuseStore {
  private readonly clock: () => number;

  constructor(
    private readonly redis: RedisClient,
    clock: () => number = () => Date.now(),
  ) {
    this.clock = clock;
  }

  private strikeKey(ip: string): string {
    return `lianrouter:model-abuse:strikes:${ip}`;
  }

  /**
   * The ban index, shared by every caller and scored with each ban's expiry.
   * A sorted set rather than a plain set: a set cannot answer "which bans are
   * still live" without reading and parsing every member, and `unban`'s
   * removal is the same `ZREM` either way.
   */
  private banKey(): string {
    return "lianrouter:model-abuse:bans";
  }

  async record(attempt: ModelAbuseAttempt): Promise<ModelAbuseOutcome> {
    const { ip, valid, threshold, windowMs, banTtlMs } = attempt;
    const raw = await redisEvalTuple(
      this.redis,
      MODEL_ABUSE_SCRIPT,
      2,
      this.strikeKey(ip),
      this.banKey(),
      valid ? "1" : "0",
      String(Math.max(1, windowMs)),
      ip,
      String(this.clock()),
      String(threshold),
      String(Math.max(1, banTtlMs)),
    );
    return decodeOutcome(raw);
  }

  async listBans(): Promise<readonly ModelAbuseBan[]> {
    const now = this.clock();
    await this.redis.zremrangebyscore(this.banKey(), "-inf", String(now));
    const entries = await this.redis.zrange(this.banKey(), "0", "-1", "WITHSCORES");
    const bans: ModelAbuseBan[] = [];
    for (let index = 0; index + 1 < entries.length; index += 2) {
      const ip = entries[index];
      const score = entries[index + 1];
      if (ip === undefined || score === undefined) break;
      bans.push({ ip, reason: "repeated_invalid_model_requests", expiresAt: Number(score) });
    }
    return bans;
  }

  async isBanned(ip: string): Promise<boolean> {
    const now = this.clock();
    const score = await this.redis.zscore(this.banKey(), ip);
    if (score === null) return false;
    if (Number(score) > now) return true;
    // Expired but not yet reaped by the script: drop it here so the index
    // does not accumulate dead members between invalid attempts.
    await this.redis.zrem(this.banKey(), ip);
    return false;
  }

  async unban(ip: string): Promise<boolean> {
    const removed = await this.redis.zrem(this.banKey(), ip);
    return Number(removed) > 0;
  }

  async ban(ip: string, ttlMs: number): Promise<number> {
    const expiresAt = this.clock() + Math.max(1, ttlMs);
    await this.redis.zadd(this.banKey(), String(expiresAt), ip);
    return expiresAt;
  }
}

export interface ModelStrikeServiceOptions {
  readonly threshold?: number;
  readonly windowMs?: number;
  readonly banTtlMs?: number;
}

/**
 * Graduated model-abuse strikes over a store.
 *
 * `noteInvalid` records one invalid-model attempt and reports the escalation
 * decision. `noteValid` is deliberately a no-op: a valid request does not
 * reset the window, because a prober that occasionally guesses a real model
 * name would otherwise erase its own history. `listBans`/`unban`/`ban` are the
 * console's escape hatch.
 *
 * Thresholds are module constants rather than environment knobs. They are an
 * internal safety margin, not a deployment setting: no operator needs a
 * different strike count per host, and a tunable would invite exactly the
 * "temporarily raise it to unblock myself" change the layer exists to prevent.
 * A test that needs a different threshold passes it to the constructor.
 */
export class ModelStrikeService {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly banTtl: number;

  constructor(
    private readonly store: ModelAbuseStore,
    options: ModelStrikeServiceOptions = {},
  ) {
    this.threshold = Math.max(1, options.threshold ?? DEFAULT_THRESHOLD);
    this.windowMs = Math.max(1, options.windowMs ?? DEFAULT_WINDOW_MS);
    this.banTtl = Math.max(1, options.banTtlMs ?? DEFAULT_BAN_TTL_MS);
  }

  /** The strike count that trips a ban, for the client-facing warning. */
  get limit(): number {
    return this.threshold;
  }

  get banTtlMs(): number {
    return this.banTtl;
  }

  /** Ban lookup for the pre-prepare gate. Throws only on store outage. */
  async check(input: { readonly ip: string }): Promise<boolean> {
    return this.store.isBanned(input.ip);
  }

  /** Records one invalid-model attempt and returns the escalation decision. */
  async noteInvalid(input: { readonly ip: string }): Promise<ModelAbuseOutcome> {
    return this.store.record({
      ip: input.ip,
      valid: false,
      threshold: this.threshold,
      windowMs: this.windowMs,
      banTtlMs: this.banTtl,
    });
  }

  /** A valid model request does not reset the invalid-attempt window. */
  async noteValid(_input: { readonly ip: string }): Promise<void> {}

  async listBans(): Promise<readonly ModelAbuseBan[]> {
    return this.store.listBans();
  }

  async unban(ip: string): Promise<boolean> {
    return this.store.unban(ip);
  }

  /** Operator instant-ban: one address, full TTL, no strike history needed. */
  async ban(ip: string): Promise<ModelAbuseBan> {
    const expiresAt = await this.store.ban(ip, this.banTtl);
    return { ip, reason: "repeated_invalid_model_requests", expiresAt };
  }
}

/**
 * The typed rejection a banned caller receives.
 *
 * 403 with its own code, so the console and the client can tell an abuse ban
 * apart from a per-request rejection. The message names the reason and the
 * route that lifts it, and says nothing about how long the ban lasts — that
 * would only tell a prober how long to wait.
 */
export function modelAbuseBannedError(): GatewayError {
  return new GatewayError(
    "model_abuse_banned",
    403,
    "This client address is temporarily blocked for repeated requests naming models it may not use. Use GET /v1/models to see the models this key allows.",
    { reason: "model_abuse_banned" },
  );
}

/**
 * The message a rejected model request carries, with the escalating warning.
 *
 * An honest client that mistyped sees "Warning 1 of 10" and can correct
 * itself; a prober sees the same sentence and learns only that the counter
 * moved. The remaining count is stated because it is the actionable half, and
 * the ban duration is not because it is not.
 */
export function modelWarningMessage(
  model: string,
  outcome: ModelAbuseOutcome,
  limit: number,
): string {
  const remaining = Math.max(0, limit - outcome.strikes);
  const tail =
    remaining === 0
      ? "The next invalid request will temporarily block this address."
      : remaining === 1
        ? "1 more invalid request will temporarily block this address."
        : `${remaining} more invalid requests will temporarily block this address.`;
  return `Model '${model}' is not available to this API key. Warning ${outcome.strikes}/${limit} — ${tail} Use GET /v1/models to see the allowed models.`;
}

/**
 * Re-throws a model rejection carrying the escalating strike warning.
 *
 * The code, status, and origin are unchanged — only the message gains the
 * count, and the count rides in `details` so the console can render it. The
 * request still fails exactly as it did before; what changes is that an honest
 * client learns the counter moved instead of seeing the same generic 404 until
 * it is banned.
 */
export function withModelStrikeWarning(
  error: GatewayError,
  outcome: ModelAbuseOutcome,
  limit: number,
): GatewayError {
  const model = String(error.details.model ?? "");
  return new GatewayError(
    error.code,
    error.status,
    modelWarningMessage(model, outcome, limit),
    {
      ...error.details,
      strikes: outcome.strikes,
      strike_limit: limit,
      remaining_before_ban: Math.max(0, limit - outcome.strikes),
    },
    error.origin,
  );
}
