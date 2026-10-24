# Providers

`src/providers/` is the single authority for every upstream LLM provider LianRouter can route to: provider
identity and base URLs, the lazy capability registry, the shared OpenAI-compatible dispatch path, credential
envelopes, model definitions, usage normalization — plus four capability subsystems (`authentication/`,
`quota/`, `discovery/`, `operations/`) and every per-provider wire/OAuth/quota implementation
(`integrations/`). Routing, console, and telemetry consume providers only through the registry and the
operations services here; nothing else hardcodes a provider host, model list, or OAuth flow.

## Layout

```text
src/providers/
  provider-metadata.ts    identity: bundled IDs, base URLs, JWT verification, upstream sanitizers
  provider-registry.ts    contracts + runtime: ProviderModule, ProviderAdapter, ProviderRegistry, credential resolution
  default-registry.ts     wiring: PROVIDER_CAPABILITIES map + BUNDLED_PROVIDER_MODULES + createDefaultProviderRegistry()
  compatible-adapter.ts   shared OpenAI-compatible dispatch (BaseProviderAdapter template lifecycle)
  credential-envelope.ts  TokenEnvelope + unwrapProviderToken (adapters never emit "Bearer Bearer")
  model-definition.ts     static catalog shape: defineModel, manual-model defaults
  reasoning.ts            canonical reasoning-intent → per-wire reasoning payload helpers
  usage.ts                usage home: normalizeUsage, usageFromProvider, repriceUsage, wire encoders
  authentication/         OAuth kit every per-provider login client builds on
  discovery/              model probing: discovery contract, /models fetcher, non-OpenAI rosters,
                          offline billing catalog, sync service
  operations/             runtime glue: seeding, caches, version resolution, health, credentials, deadlines
  quota/                  quota kit: one result shape, dispatch, connectivity probe, declarative window engine
  integrations/           one module (or directory) per provider: adapters, OAuth, quota, CLI-version quirks
```

## Registration: metadata × capabilities × lazy import

Three layers combine in `default-registry.ts: BUNDLED_PROVIDER_MODULES`, then `createDefaultProviderRegistry()`
→ `toRegistration()` → `ProviderRegistry.register()`.

1. **Metadata** (`provider-metadata.ts: RAW_BUNDLED_PROVIDER_METADATA`): `id`, `displayName`, `baseUrl` are
   the only required fields. Optionals: `wireFamilyDefault` (default `chat`; `messages` for
   `anthropic`/`claude`, `responses` for `codex`), `requiresAccount` (only `opencodeft: false`),
   `defaultBypassProxy` (no bundled provider sets it today; the field remains for one that must
   always dial direct), `credentialUrl` (only `groq`), `jwtVerification` (only `grok`).
   `providerBaseUrl()` is the single declaration of origin; `providerUpstreamHost()` carries the SSRF
   binding, so dispatch needs no second map. For `opencodeft` the origin is overridable at
   deployment time through `LIANROUTER_OPENCODEFT_BASE_URL` (read via `resolveOpenCodeFtBaseUrl()`).
   The free gate validates the request-side client fingerprint (desktop `User-Agent` with a
   version at or above `1.18.0`, `x-opencode-*` correlation headers, the `bash`/`glob`/`grep`/`read`
   tool quartet, and `Authorization: Bearer public`), which `buildOpenCodeFreeHeaders` +
   `ensureFreeAgentRequest` install in-process — direct dispatch works and is the default. A CLI bridge remains an
   optional deployment fallback for an environment whose edge rejects the in-process client, but
   it is lossy: a CLI bridge flattens message content to text and drops `tools`, so vision and
   tool calls declared by the catalog stop working. Point the override at a bridge only when
   direct dispatch itself returns `FreeTierError`. A DB `base_url` on the bundled row is not an
   option — custom rows only, and
   `registerByokProviders()` rejects bundled-id collisions at boot.
   **The fingerprint is not the limit.** Verified against the live endpoint with the adapter's own
   captured request bytes: a correct fingerprint returns `200` and a real stream, a malformed
   `x-opencode-session` returns `403 FreeTierError`, and a `user-agent` below `1.18.0` returns `426
   UpgradeRequired`. Separately, the free tier's *allowance* cannot be keyed on a credential — this
   provider is `requires_account: false` and sends the literal `Bearer public`, so there is no
   account identity to key on and no account to fail over to.
   **The free-tier allowance is keyed on the source address.** A spent address answers
   `FreeUsageLimitError` (`429`) no matter which `x-opencode-session` it is given; an unspent one
   answers `200` for a reused handle and a freshly minted one alike. Rotating the proxy is therefore
   what changes the quota, and the pool is the unit of that rotation. Confirmed from production
   telemetry (24h and all-time): real client traffic to this provider produced **zero** 429s while
   every one of the recorded `FreeUsageLimitError` events came from the console's model-probe path,
   which is what burned the addresses.
   **The session handle is an identity, not a quota key.** `stableOpenCodeSessionId` keys
   `x-opencode-session` per `(credential identity, egress)`. That is correct on its own terms — the
   handle carries prompt-cache affinity and is the identity upstream attributes a request to, so two
   tenants, two accounts, or two exits must not present the same one. The previous key resolved to a
   single constant (`opencode:default`) for every dispatch — `credential.secret` is a `Uint8Array`
   and the old key only accepted a `string`, so even two distinct paid accounts collided — and
   fixing that is worth keeping. It does **not** buy quota: a fresh handle from a spent address is
   still refused. `invalidateOpenCodeSession` retires the handle on the structured
   `FreeUsageLimitError` (`details.freeTierAllowanceExhausted`) as hygiene, not as a remedy; a bare
   429 or a 5xx leaves it alone. Worst case the session map holds `MAX_STABLE_SESSIONS` (1000)
   entries, each expiring after `STABLE_SESSION_TTL_MS` (1h), with LRU eviction at the cap —
   bounded regardless of how many identities or pools exist.
   **What actually lifts the limit is the pool cooldown.** `classifyRateLimitScope` scopes this
   provider's 429s to `network`, `shouldCooldownPool` accepts that, and the attempt loop calls
   `flagPoolCooldown` for the (pool, provider) pair, so the selector stops handing out that spent
   exit.
   **The probe path cools its pool too.** `ProviderProbingService` dispatches outside `runAttemptLoop`,
   so it cannot inherit the attempt loop's cooldown; it calls `flagPoolCooldown` itself, gated on the
   same predicates live dispatch uses — `shouldCooldownPool(error) || isPoolConnectFailure(error)`.
   A probe that burns an address therefore retires that (pool, provider) pair instead of leaving it
   selectable for the next probe or client request, which is what let probe traffic spend a set of
   addresses while client traffic never saw a 429. The gate is deliberately no looser than the client
   path: a bad model id, empty content, a deadline, or a 400 says nothing about the egress and must
   not sideline a healthy pool. `recordProbeHealth` keeps owning account health separately — pools and
   accounts are different machines, and the account branch still runs for credentialed providers.
   > **Koreksi.** Two earlier readings in this doc were wrong and are retracted here. First, that
   > this was purely a per-address cap with the handle irrelevant: the handle sharing was real
   > (every caller collided on `opencode:default`) but it was not the cause of the observed 429s.
   > Second, that the shared handle made a spent allowance "follow the gateway across every exit":
   > that inverted the causality. Both exits were simply already spent — 16 pools had been burned,
   > and the probe path is what burned them. The per-address keying is the correct model; the
   > identity-scoped handle stands on its own merits and is not a quota mechanism.
   The `*-free` model rows stay in the catalog: they are
   referenced by tenant aliases and fallback combos, and `seedBundledModels` prunes any `builtin`
   row the catalog no longer declares, after which routing reports `model_not_found` for the alias.
   `DEFAULT_PROXY_BYPASS_PROVIDER_IDS` derives the one
   proxy-bypass default that console routing, provider detail, and domain registration all read.
   `PROVIDER_COMPATIBILITY_PROFILES` holds wire overrides for the three `opencode*` hosts and for
   `browseruse`, whose two dialects live under one origin. `PROVIDER_PROMOTIONS` carries
   time-boxed promotions (label, model ids, inclusive date window) that the provider console
   surfaces as a badge; an ended window disappears on its own. WorkBuddy's free
   `deepseek-v4.1-flash` window is the first entry — the provider serves that metadata only
   inside its authenticated product config, so the window is declared here rather than fetched.
2. **Capabilities** (`default-registry.ts: PROVIDER_CAPABILITIES`, keyed by every `BundledProviderId` with
   a `satisfies` check, so a missing key is a type error): `loadAdapter` (required) plus any of
   `loadModels`, `loadAuthentication`, `loadQuotaCollector`, `loadModelDiscovery`,
   `modelDiscoveryRequiresCredential`, `endpointPathsByWireFamily`, with `oauthCapability()` /
   `quotaCapability()` / `openAIModelDiscovery()` / `configuredProvider()` factories.
3. **Lazy import**: every `load*` is `async () => (await import("…")).export`, so nothing provider-specific
   evaluates at startup. `resolve()`, `resolveAuthentication()`, `resolveQuotaCollector()`, and
   `resolveModelDiscovery()` single-flight and cache on first use, keeping protobuf-heavy adapters
   (Cursor, Devin) out of the boot path.

**Capability split.** `loadAdapter → ProviderAdapter.dispatch()` takes a canonical request and emits
canonical events, via `createApiKeyAdapter(spec)` / `OpenAICompatibleAdapter` or a bespoke class.
`loadAuthentication → { client, refresher }` serves the console login routes;
`loadQuotaCollector → QuotaFetcher` serves the console quota routes and never dispatch health;
`loadModelDiscovery → ProviderModelDiscovery` (+ credential flag) is TTL-cached 10 min when credential-free,
always live when credential-scoped.

**Browser Use is one provider with two dialects.** `integrations/browseruse.ts` serves the OpenAI
chat wire on `/api/v4/llm/v1/chat/completions` and the Anthropic Messages wire on
`/api/v4/llm/anthropic/v1/messages` from `https://api.browser-use.com`, both authenticated with the
same bearer token — which is why it is one row rather than an OpenAI-compatible row plus an
Anthropic-compatible one. The Messages side gates on the Claude Code fingerprint, so
`buildExtraHeaders` stamps `buildCustomClaudeCliHeaders()` for that wire only; without it the
gateway answers with a synthetic run-exit stub instead of model output. The gateway also
mislabels response framing (a JSON answer keeps the SSE terminator), which the shared transport
handles — see `src/protocol/PROTOCOL.md`.

BYOK/custom providers bypass all of the above: `registerByokProviders()` / `syncByokProvider()` build an
`OpenAICompatibleAdapter` from the DB row's `base_url` + `compatibility_profile` and register it via
`registry.upsert()` — no restart, SSRF-validated hosts via `liveProviderUpstreamHosts()`.

**Derived wire contract** (`operations/byok-wire-profile.ts`). A custom row persists only a base URL, an
optional compatibility profile, and `wire_family_default`; the adapter's served families, per-family
endpoint paths, and credential header shape are *derived* from those so registration
(`provider-catalog-service.ts`) and the probe/model-sync fallback (`discovery/probing-service.ts`) cannot
drift. An explicit `endpoint_paths_by_wire_family` names exactly the served families; otherwise a `chat`
default serves the OpenAI pair (`chat` + `responses`) and a `messages` default serves `messages` only.
`embeddings` is opt-in only: a profile that declares it gets the bare-root `/v1/embeddings` path and the
generic adapter posts there, while a provider that does not declare it keeps rejecting that wire. The
credential header follows protocol truth, not a per-provider special case: a Messages-only upstream reads
`x-api-key`, anything that also serves an OpenAI wire reads `Authorization: Bearer`. `cli_identity`
(boolean, default true) controls whether the official CLI identity headers are stamped; the mutually
exclusive `gateway_user_agent` (boolean) instead stamps `user-agent: LianRouter/<version>` from
`operations/gateway-user-agent.ts`, which is how a provider opts out of CLI cloaking.
`POST /providers/connection-test` (ad-hoc, unsaved provider) reuses the same derivation to probe
`GET <base>/v1/models` with the matching auth header before anything is persisted.

## Seeding / catalog / discovery flow

1. **Static source of truth**: per-provider `*_MODELS` arrays built with `defineModel`, with limits/cost
   fallback into `discovery/models-dev-catalog.ts` (offline `base-models.json` snapshot, no runtime
   network) — except a row marked `free: true`, which always takes `FREE_TIER_COST` (zero input/output) so a
   free-tier entry is never priced by the model it wraps; loaded lazily via `loadModels` and memoized
   per-process by `operations/model-catalog-cache.ts`.
   The catalog fallback covers **limits and pricing only**, and now resolves them per provider: an exact
   `provider:model` row always wins, and the bare-id fallback answers only when every row for that id agrees
   — `undefined` otherwise, so a row keeps its own declared limits instead of inheriting another reseller's
   (hundreds of bare keys disagree about limits/pricing across resellers). Capability is declared by
   the row and never inherited. A capability a row does not name is left to the routing ladder rather than
   guessed — `buildCapabilityProfile` treats the
   codec wires as able to carry image/document/audio parts, and an upstream that cannot accept one degrades
   it itself. Reasoning and tools are never stripped: `buildCapabilityProfile` grants both regardless of the
   row's recorded flags or its `source`. A `false` there — a discovered row with no metadata, or a catalog row
   set explicitly — must not silently rewrite a request the caller asked for. The upstream decides whether it
   can serve them and returns its own error if it cannot.
2. **DB materialization**: `seedBundledProviders()` upserts `providers` rows; `bundledModelCatalog(registry)`
   aggregates `modelsByProvider` (conflicting endpoint paths for one wire family throw); `seedBundledModels()`
   reconciles `models` rows keyed `(provider, model, endpoint)` — deletes drifted builtin pairs, upserts with
   capability/cost reconciliation, never touches operator `enabled`.
3. **Live discovery**: credential-free providers are TTL-cached, credential-scoped discovery is always live.
   Generic path is `fetchOpenAICompatibleModels()`; one-shot connectivity probes go through
   `discovery/probing-service.ts`, sharing the catalog contract with console routes.

## Authentication: the OAuth kit

Provider-agnostic kit every per-provider login client builds on: the `OAuthLoginClient` contract, PKCE
helpers, device-flow correlation, token-endpoint request lifecycle, local JWT inspection, cross-process
refresh orchestration. Provider specifics (authorize URLs, client IDs, token field names, JWKS manifests)
stay in `integrations/<name>/*-oauth.ts`.

- **One login contract.** `OAuthLoginClient` declares device-code and browser-code support plus
  authorize/exchange/start/poll methods; each client implements only the flows its upstream offers.
- **Base class and lifecycle.** `oauth-client.ts` encapsulates PKCE authorize-URL building, form token
  exchange, normalized token parsing, and refresh, with protected hooks for scopes, extras, and field
  mapping; its `FetchLike` seam keeps tests off the network. `oauth-device-flow.ts` owns the generic device
  start/poll lifecycle; `oauth-flow-store.ts` owns token-endpoint POST helpers, deadline-composed signals, and
  the Redis-backed `OAuthFlowStore` (900s TTL) holding pending browser flows, device correlation, and
  `providerState` — which the console routes persist, so an in-flight login is shared across instances.
  Response parsing stays with the caller, where provider field names live.
- **JWT as defense-in-depth.** `jwt-validator.ts` treats TLS-to-the-issuer as the primary trust boundary:
  opaque tokens pass through untouched, JWTs always get structural and registered-claim checks, and
  signature verification only when the manifest declares `providerJwtVerification` (JWKS). Only asymmetric
  algorithms verify; `none` and `HS*` are rejected against downgrade.
- **Coordinated refresh.** `oauth-refresh-service.ts` layers an in-process single-flight map over a Postgres
  lease (`lease_owner` / `lease_expires_at`) acquired by conditional `UPDATE`; `persistRefreshed` /
  `disableAccount` are lease-fenced, so a loser whose lease expired writes zero rows instead of clobbering
  its peer. `loadAccountWithFreshness` supplies the skew-adjusted `dueAt` (`OAUTH_REFRESH_SKEW_MS`, 5 minutes).
- **Typed refresh failures.** `DEFINITIVE_PATTERN`
  (`invalid_grant|invalid_token|unauthorized_client|revoked|refresh_token.*expired`) marks permanently dead
  credentials; a bare 401 with no body match is still definitive, while timeouts, 5xx, 429, and
  `temporarily unavailable` stay transient and safe to retry.

Rules: no provider host, client secret, or token field name lives here. `providerState` is server-side only
and never echoed to the dashboard. Opaque tokens are never locally "validated"; the issuer validates them on
next use. Refresh never races: same-process callers share one promise, cross-process peers fence on the lease
owner id. Token helpers must not leak `Bearer` material into logs or errors.

## Quota: one shape, one window engine

Shared kit: one result shape, one dispatch entry point, one declarative window parser, one connectivity probe
for key-only providers. Provider specifics (endpoint URLs, field names, plan derivation) live in
`integrations/<name>/*-quota.ts` and the registry's `loadQuotaCollector`.

- **One result shape.** `ProviderQuotaResult` carries `source`, `plan`, `windows` (each a
  `ProviderQuotaWindow`: `kind`/`label`, used/remaining percents, `resetsAt`, optional absolute
  `used`/`limit` and `recurring`), and `error`. Every collector returns it, so console surfaces never branch on
  provider identity. The shared guards coerce unknown upstream JSON without throwing (`isoDate` accepts epoch
  seconds/millis and date strings), and `cleanError` redacts `Bearer` material and caps messages at 240 chars.
- **Dispatch through the registry.** `fetchProviderQuota` lowercases the caller id, canonicalizes it with
  `resolveProviderId`, and resolves the handler via `registry.resolveQuotaCollector()`; a provider with no
  collector gets `unsupportedQuota(providerId)`. `QuotaFetcher` is the
  `(credential, fetcher) => Promise<ProviderQuotaResult>` type the registry supplies.
- **Declarative window engine.** `parseQuotaWindows` maps a response tree to windows from
  `QuotaWindowMapping` rows: priority-ordered value paths for used/remaining percent, reset, and absolute
  used/limit, plus `valueMultiplier` (e.g. 100 for 0–1 ratios), `derivePercent`, `emitWithoutPercent` for
  countdown-only windows, and plan overrides. Only simple percentage-tree responses use it — Tencent billing
  envelopes, WorkOS usage arrays, and duration-derived labels keep bespoke parsers.
- **Key-only connectivity probe.** `probeApiKeyConnectivity` hits the provider's `/models` (via
  `providerBaseUrl`) with the key: 401/403 means definitively invalid-or-revoked, 2xx means valid, anything
  else is an inconclusive transport/wire error surfaced as-is, never a credential verdict. It throws on
  transport failure and returns a `ProviderQuotaResult` otherwise. It sends no probe-specific User-Agent.
- **Cline's collector routes by credential kind.** `api_key` credentials (wrapped by
  `markClineApiKeyCredential`) go to that `/models` probe, while OAuth credentials keep the
  `users/me` quota surface — keys carry no OAuth envelope and upstream exposes no quota
  endpoint for them, so a 401 from `users/me` would be meaningless.

Rules: `FetchLike` is the transport seam — collectors take an injected fetcher so tests never touch the
network; quota fetches time out at 15s. Collection is read-only and best-effort: failures land in
`result.error`, never as thrown dispatch errors. Absolute `used`/`limit` are optional enrichment; percents
plus `resetsAt` are the contract the dashboard renders. `codexJwtAccountId` is the one sanctioned JWT peek
here — quota attribution, not authentication.

## Discovery: what models exist, and do they work

Owns the credential-scoped discovery contract, the tolerant OpenAI-compatible `/models` fetcher, the offline
models.dev billing catalog, and the probing/orchestration service that syncs discovered models into the
database. Per-provider entry points live in `integrations/`, registered as each `loadModelDiscovery`.

- **Non-OpenAI rosters.** `discovery/bespoke-model-discovery.ts` reads a model list and pins every id to a
  named wire family and endpoint; `discovery/provider-model-lists.ts` supplies the per-provider request
  (URL, auth header, wire). A provider whose roster is not a flat chat list — Kimi and the four MiniMax
  plans on Messages, Muse and Codex on Responses, Copilot's policy-filtered catalog, ClinePass's
  `cline-pass/` bucket, MiniMax's nested agent envelope — goes through there rather than through
  `fetchOpenAICompatibleModels`, because the generic fetcher would register those ids on
  `/v1/chat/completions` rows the adapter rejects with `capability_unsupported`. `test/providers/discovery/
  discovery-request-contract.test.ts` pins the URL and auth header of every wired provider's request, so a
  wrong header cannot pass as "wired".
- **One discovery input.** `DiscoveryInput` is the credential-scoped entry shape every adapter's
  `discover*Models` takes: `credential`, optional `signal`, optional injectable `fetcher`.
  `ProviderModelDiscovery` (`context => ModelDefinition[] | null`) types the registry-facing boundary; a
  `null` return means "no data", never an error.
- **Tolerant `/models` parsing.** `fetchOpenAICompatibleModels` accepts `data|models|items` envelopes and
  assorted pricing/context field names, detects chat-vs-responses wire families per entry, sanitizes unknown
  ids via `sanitizeUpstreamLabel`, and falls back to the offline billing catalog: `modelsDevCatalog` loads
  `base-models.json` once and exposes `resolve(providerId, modelId)` — exact `provider:model` under the id's
  models.dev filing name (see below), then an unambiguous bare id, then its date-stripped form, `undefined`
  when none match or the bare id is ambiguous — for context/output metadata plus `costFor()` — enrichment
  with no network round-trip. Precedence at the call site is upstream first, then this catalog, then the
  floors: `parsedContext ?? fallback?.contextLimit ?? 200_000` (and `64_192` for output), so a provider that
  states its own limits is never overridden by the catalog. models.dev is authoritative mainly for **pricing**
  — an upstream `/models` response rarely states a price — and its limits are a secondary source.
  `resolve()` is fail-closed and provider-specific (right for metadata), while `costFor()` additionally
  falls back to the rate the catalog records for the model itself: a reseller that republishes a model
  without publishing its own rate is billed the model's global rate, never `$0.00`. Discovery callers pass
  their `providerId` so limits and pricing come from the row for
  the provider actually serving the model. Non-OK responses
  return `null`; the request carries a 10s timeout composed with the caller's signal.
- **Provider id → models.dev filing name.** A LianRouter provider id is not always the key models.dev uses:
  `opencodeft` serves `opencode.ai`, whose rows models.dev files under `opencode`. `MODELS_DEV_PROVIDER_IDS`
  in `models-dev-catalog.ts` maps those ids, and `resolve` tries the id as given first, then the mapped name —
  a second chance, never an override, so a provider the catalog already carries under its own id still wins.
  The mapping covers only ids backed by the deployment's own upstream; a match resting on model ids alone is
  deliberately absent, because the same generic id appears under hundreds of resellers and a guess would
  attribute a stranger's limits to this gateway's serving — the failure the bare-id disagreement rule exists
  to prevent. A provider with no models.dev counterpart (a private gateway, a BYOK endpoint) stays unmapped
  and keeps its declared limits.
- **Refreshing the snapshot.** `bun run scripts/ci-generate-models-dev-snapshot.ts` re-downloads
  `https://models.dev/api.json` and rewrites `base-models.json` (minified, one row per `provider:model`,
  pruned to the fields the resolver reads). Run it by hand when the catalog goes stale; the server never
  fetches models.dev at runtime.
- **Probing orchestration.** `ProviderProbingService` separates network probes from the Drizzle catalog
  repository while sharing the provider catalog contract: `probeModel` runs a one-shot connectivity test
  (latency + TTFB + sample or typed error, honoring an optional `route`/`wireFamily` override),
  `probeAllModels` batches at `PROBE_CONCURRENCY = 5` after a sequential warm-up, and `syncModels`
  reconciles into the `models` table. Every attempt resolves its credential via `resolveCredentialForAccount`,
  classifies failure with `classifyUpstreamFailure`, and reports health through `recordAccountFailure` /
  `recordAccountSuccess`. The phases `probeModel` orchestrates — target/endpoint resolution, account
  selection, adapter resolution, preference loading, request construction, health recording, verdict
  computation, and sample extraction — live in `discovery/probe-phases.ts` as plain functions taking a small
  args object, so the method body reads as named steps. The dispatch-and-retry step stays inline: it owns
  the event stream, TTFB, captured request, and pool binding across the retry, and its `release` must run on
  the same frame as the binding. A probe's pre-stream budget is `LIANROUTER_UPSTREAM_TIMEOUT_MS` — the same
  contract live dispatch enforces — and the streamed retry re-arms both the signal and the deadline, because
  a budget already consumed by the first attempt cannot also cover the retry. A tighter fixed budget reports
  a healthy reasoning model as `transport_closed` and the operator reads "request was cancelled" for a
  provider that was only thinking. Probe dispatch carries `LIANROUTER_PROBE_MARKER` in
  `ProviderDispatchContext` and telemetry; `createProbeFetch` strips any
  `User-Agent` before the validated fetch.
- **Wire reconciliation.** `applyDiscoveredWire` merges a discovered wire family/endpoint onto a registered
  model for probing without mutating the catalog; `staticEndpointForWire` maps a wire family to the
  provider's own bundled-catalog path and backs explicit-wire probes plus manual registration. Probing takes
  its outbound fetch from `ProbeOutboundResolver`, which may return a pool-bound binding carrying fetch +
  `networkPoolId` + `release`.

Rules: discovery never imports console presentation types — probe contracts live here so the lower layer
stays console-free. Failures yield `null` or a `ProbeModelResult` with `ok: false`, never a thrown dispatch
error. A failed probe carries the status it stands for (`httpStatus`, plus `code`) rather than a fixed one:
`computeProbeVerdict` passes a `GatewayError`'s own status and code through, so an upstream 429 is recorded
and answered as 429, and only an unclassified throw (`unknown_error`, no `GatewayError`) becomes 500. The
console records that status in `telemetry_events.http_status`; without it the Usage projection fills a
`failed` row with 500 and an exhausted free tier reads as a gateway fault. Credential-free discovery may be
cached (see Operations); credential-scoped discovery is never cached
here, because entitlements must reflect the caller's account. Upstream arrays and numbers pass through
bounded-array and bounded-number guards so a hostile `/models` payload cannot blow up memory. A wire family
is never taken from the discovery payload alone: the generic `/models` fetcher carries no wire information
and guesses from the model id, so `applyDiscoveredWire` admits a guess only when the provider's own contract
(`supportedWireFamilies`, from the registry or the BYOK profile) contains it. Without that gate a
Messages-only custom provider was discovered onto `chat` rows its adapter rejects at dispatch with
`capability_unsupported`, and a chat-only OpenAI-compatible provider inherited the `responses` guess for
`gpt-5`/`o3`-style ids. A corrected wire family moves a model to a new `(model, endpoint)` row, so a sync
also prunes that provider's superseded `discovered` rows for the ids it resolved.

## Per-provider system prompt

`provider_routing_settings.system_prompt` is optional text prepended to every request routed to that
provider, as a canonical `system` part. Empty/NULL injects nothing, which is the default for every row.

- **Why per provider, not global.** The reason to add one is a property of the upstream — it wants a
  nudge, a format reminder, or a routing hint — and one global prompt would corrupt every model that
  did not expect it. `route-catalog.ts` resolves the prompt for the candidate's tenant into
  `RouteCandidate.system_prompt`, so only providers with a configured prompt carry the field at all.
- **Why the routing table, not `providers`.** A built-in provider's `providers` row is seeded and owned
  by the build, and the console refuses to write it (`provider_is_builtin`). The setting belongs where
  the operator can actually reach it: beside `bypass_proxy` and `max_inflight`, on the row that already
  holds the per-provider operator settings.
- **Tenant override is per field.** A tenant row wins for the fields it sets, and an unset prompt falls
  through to the global (`tenant_id IS NULL`) row — not the whole-row precedence
  `resolveTenantOverride` applies to the other routing settings. A tenant that changed only its strategy
  must keep inheriting the global prompt rather than blank it. `console/providers/detail/store.ts`
  reports the same chain, so the card and dispatch cannot disagree.
- **Why it lives on the candidate.** Failover moves an attempt to a different provider, and each
  provider's text is its own: an attempt that falls back must carry the text of the provider it
  actually reaches, not the one it started on. `dispatch/proxy-request.ts` merges it per attempt,
  before either the streaming or the buffered path reads `dispatchRequest`.
- **Why `system` and not `instructions`.** All four wire encoders emit `system`; `instructions` is
  Responses-only, so a hint written once would vanish on a chat or messages route.
- **Order.** The provider text is prepended, the client's own system content follows it. Neither
  overwrites the other.
- **Ceiling.** `MAX_PROVIDER_SYSTEM_PROMPT` (8 000 chars) is enforced by `normalizeSystemPrompt`,
  which also maps empty/whitespace to NULL so a blank string cannot become an empty system message on
  every request.

## Media ids are not registered

Some upstream catalogs list image and video generation models alongside their chat models. Those ids
are deliberately absent from the bundled catalogs because the gateway has no image or video wire
family — `WireFamily` is `chat | responses | messages | embeddings | native`, and `native` is a
per-provider codec (Cursor, Devin), not a generic media escape hatch. Registering one of these ids as a
`chat` row would advertise a capability dispatch cannot serve.

Known ids in this position, recorded so the omission reads as a decision rather than an oversight:

- `xai` — `grok-2-image-1212`, `grok-imagine-video`.
- `venice` — `venice-sd35`, `flux-2-pro`, `gpt-image-2`.

Their providers' text and embedding models are registered normally. Adding these would mean introducing
an image/video wire and its request/response codec first.

## Operations: runtime glue

Runtime glue between the static registry and the database: seeding, layered caches, client-version
resolution, account health, credential decryption, CLI identity headers, session affinity, upstream
deadlines. Routing, console, and discovery consume providers through these services — never by importing
`integrations/` or hardcoding hosts, versions, or health thresholds.

- **Catalog materialization.** `seedBundledProviders` idempotently inserts every `BUNDLED_PROVIDER_MODULES`
  row (`onConflictDoNothing`, then a compatibility-profile merge `UPDATE`). It never prunes: a provider
  removed from the bundle keeps its global `providers` row, because deleting that row would cascade its
  accounts, models, and routing settings for a removal the operator may not have intended. The row is
  surfaced as `stale` and the operator deletes it explicitly (see `CONSOLE.md`). `seedBundledModels` persists the
  compiled `ModelDefinition` maps and deletes stale `builtin` rows by the `(model, endpoint)` composite key,
  so a moved endpoint never leaves a duplicate dead route. `registerByokProviders` / `syncByokProvider` wire
  tenant-supplied endpoints with SSRF validation.
- **Three cache layers.** `getCachedModels` caches the loader *promise* per provider for the process lifetime
  (LRU-bounded, failures evicted so they retry). `getCachedModelDiscovery` caches only credential-free
  discovery (e.g. Cline's public roster) for 10 minutes. `getCachedVersion` caches version strings in a TTL
  cache (5-minute default; the resolver's own is 30 minutes) with backoff retry and single-flight dedupe.
- **Client-version resolution.** `createClientVersionResolver({ key, fallback, sources, minVersion? })`
  returns a sync `get()` plus async `ensure()` / fire-and-forget `refresh()` and test-only `reset()`.
  Resolution order is discovered → pinned fallback, so a stale version always beats blocking dispatch; there
  is no environment override. Sources default to npm-style `version` / `dist-tags.latest` JSON, covering npm,
  PyPI, and plain-text release pointers; WorkBuddy desktop additionally reads the official
  `https://www.workbuddy.ai/v2/update?platform=workbuddy-win32-x64-user` manifest because its
  four-segment desktop build version is not standard semver. `minVersion` discards any discovered version below it —
  trap: npm's `cline` package is the 3.x CLI while Cline's API gates on the 4.x extension version, so probing
  npm first "upgraded" Cline 4.1.18 → 3.0.62 and the API rejected every request with "please make sure you're
  using the latest version". Discovery must move a client forward, never backward.
- **Account health machine.** `classifyAccountError` maps failures to `AccountErrorCategory` (`quota_exhausted` /
  `rate_limit_transient` / `model_capacity` / `auth_invalidated` / `policy_blocked` / `server_error` / `timeout` /
  `unknown`), an
  origin (`gateway`/`upstream`/`network`), and a scope (`account`/`provider`/`model`/`pool`/`tenant`/`request`/
  `network`/`unknown`). `recordAccountFailure` applies per-category fallback cooldowns, each read from
  `src/config.ts` (`LIANROUTER_ACCOUNT_RATE_LIMIT_COOLDOWN_MS` 15m, `LIANROUTER_ACCOUNT_QUOTA_COOLDOWN_MS` 1h,
  `LIANROUTER_ACCOUNT_MODEL_CAPACITY_COOLDOWN_MS` 2m, `LIANROUTER_ACCOUNT_TRANSIENT_COOLDOWN_MS` 30s,
  `LIANROUTER_ACCOUNT_UNCLASSIFIED_COOLDOWN_MS` 1m) so an operator can retune the machine without a code change.
  An upstream `Retry-After`/`x-ratelimit-reset` header or a duration quoted in the provider message always wins
  over the fallback. xAI Grok Build is the one pinned provider rule: its free-tier exhaustion
  (`subscription:free-usage-exhausted`, "included free usage", "rolling 24-hour window") is a 24h
  `quota_exhausted` cooldown — never the generic 1h fallback and never `degraded`, so the account cannot re-enter
  rotation inside the provider's own reset window. Every non-`active` classification except `disabled`
  carries a `retryAt`, because `sweepExpiredCooldowns` selects on `cooldownUntil IS NOT NULL`: a `degraded`
  row with a null deadline would never be swept back and would stay unroutable until an operator restored it
  by hand. `disabled` is deliberately permanent — a rejected credential with no OAuth-refresh recovery path
  is not swept, so it carries a null deadline. Only real credential evidence disables: deterministic
  content-policy rejections (`11140` and its safety-review phrasing) and hosted-tool failures
  (`web_search`/`x_search`/`web_fetch`) are excluded, because refreshing the token cannot change them.
  The buddy family (`cb`/`cbcn`/`workbuddy`, declared once as `BUDDY_PROVIDER_IDS` in
  `provider-metadata.ts`) is the one exception, and only as a cooldown: its `11140`
  block persists across every subsequent invocation, so the account is parked in a 24h
  `policy_blocked` cooldown (never `disabled` — the credential is valid and the block clears upstream)
  to stop routing from selecting it.
  A 402 is quota-shaped and cools down rather than disabling, and a 407 is `network`-origin so it can never
  mutate an upstream account.
  `reportAttemptOutcome` is the per-attempt hook, `recoverAccount` / `sweepExpiredCooldowns` run recovery, and
  every transition is journaled to `healthEvents`. A throttle (`rate_limit_transient` / `model_capacity`) with
  a `modelId` cools the **(account, model)** pair through `modelCooldowns` instead of the account, so the
  account stays routable for every other model; the console reports those live backoffs beside the status.
  Recovery (`recoverAccount`, a consumed rate-limit reset) clears **every** routing exclusion — account status,
  `cooldownUntil`, and the per-model `modelCooldowns` map — because the routing catalog reads each of them
  independently: a recovery that left a per-model entry behind kept the account blocked for that model over the
  public API while the account read `active` and a direct probe (which addresses the account by id, bypassing
  routing eligibility) succeeded. A periodic quota check writes the error fields only while the account is
  `active`: for a parked account those fields are the health machine's reason, and a failing quota endpoint
  reported a whole provider as "Invalid or expired credentials", overwriting the `auth_invalidated` reason a
  dispatch 401 had just recorded.
  The periodic quota sweep (`listOAuthQuotaRefreshTargets`) skips accounts already marked
  `auth_invalidated`: a rejected credential does not repair itself, so every sweep is a guaranteed 401 that
  only re-confirms the row — the operator needs a re-login, and the console labels the account
  "Re-login required" rather than a bare `disabled`. Every other account is swept, `disabled` included, because
  a disabled row is not necessarily a revoked one and skipping it would let a credential die silently while the
  row still reads healthy. Clearing the mark is what returns an account to the sweep: replacing the credential
  or re-enabling the account (`updateAccount`) resets the same failure state `recoverAccount` does, so a
  re-authed account is probed again instead of sitting out of rotation forever.
- **Per-account request concurrency and usage.** `provider_accounts.max_inflight`
  (validated from 1 through 10,000) overrides the effective tenant/global
  `provider_routing_settings.max_inflight` for that account. `null` inherits the
  provider-routing value; when that value is also `null`, admission is unlimited.
  The route snapshot carries the resolved ceiling into the account-specific
  reservation bucket. Account responses report UTC-today usage from retained
  request telemetry and lifetime usage from `telemetry_usage_totals`.
- **Credential resolution.** `loadAccountWithFreshness` loads the account row plus its optional
  `provider_oauth_states` row in one query and computes `dueAt` as expiry minus skew (`OAUTH_REFRESH_SKEW_MS`,
  5m). `resolveCredentialForAccount` decrypts the stored ciphertext into a dispatchable `ResolvedCredential`
  (triggering the refresh service when due); `resolveAccountSecretString` is the string-typed read beside it.
- **Dispatch-time request context.** `resolveCustomCliHeaders` stamps Codex-CLI identity
  (`codex_cli_rs/<version>`) on chat/responses traffic and Claude-CLI identity (`x-app: cli` + stainless
  headers) on messages traffic so upstream sees realistic first-party tooling.
  `ProviderDispatchContext.network_pool_id` names the pool the attempt's egress actually uses (absent when
  it dials direct) — one pool row is one proxy endpoint, so this identifies the source address upstream
  sees. It is set by both proxy-request dispatch paths and by the probe path, and it exists because a
  per-client upstream handle must be bound to the egress that presents it; nothing else may key on it.
  Probe dispatch carries the internal `LianRouter-Probe` marker in context and
  telemetry; `createProbeFetch` strips any `User-Agent` before the network
  boundary.
  `resolveInboundSessionId` extracts affinity from session headers in declaration order (`x-conversation-id`, `x-session-id`,
  `x-session-affinity`, `x-opencode-session`, `x-claude-code-session-id`, `prompt_cache_key`,
  `prompt-cache-key`, `session-id`) or the canonical conversation id; `resolvePromptCacheKey` prefers an explicit caller cache key from any surface
  (chat `prompt_cache_key`, responses `prompt_cache_key`, messages `metadata.user_id`) before that
  session fallback, and never includes the client IP. `withUpstreamDeadline` binds the dispatch `deadline` to an abort signal with a releasable lifecycle so
  timers never leak. Its `abortFailure` classifier separates the two aborts that reach an adapter: a client
  disconnect is `transport_closed` 499, while the gateway's own expired pre-stream budget is
  `deadline_exceeded` 504. Mapping both to 499 blamed the caller for a slow upstream and made a provider
  timeout look like a cancellation. The deadline bounds **TTFB
  only**: a streaming adapter must call `lifecycle.release()` as soon as response headers arrive, because
  from there the gateway's stall/first-chunk watchdog owns the body. Leaving the timer armed silently
  truncates slow streams — `decodeSseEvents` cancels its reader on abort, the read resolves as *done*, and
  the decoder then synthesizes a `complete` terminal for a body it never finished reading.

Rules: only successful, non-empty values are ever cached — every failure path retries instead of pinning a
miss. `liveProviderUpstreamHosts` is the single source of upstream origins for SSRF binding; no second host map. Health cooldowns are parser-driven with short deliberate fallbacks; unknown
quota cadence parks an account for 1h, not 24h, and self-corrects on re-probe. Credential ciphertext is
decrypted only inside this layer (plus the refresh service); adapters receive plaintext via
`ResolvedCredential`.

## Integrations: one adapter per provider

The only layer that knows a provider's wire envelope, auth headers, OAuth endpoints, quota shapes, and
CLI-version quirks. The registry consumes these modules lazily — every `loadAdapter`, `loadQuotaCollector`,
and `loadModelDiscovery` is a dynamic import — so nothing here may run at startup time. Pure helpers
(`connect.ts`, `buddy-*-shared.ts`) are the exception: no provider identity, imported freely.
(`reasoning.ts` is likewise pure but sits one level up in `src/providers/`.)

**Generic `ApiKeyProviderSpec` rows** (preferred for OpenAI-compatible, bearer-auth hosts) declare data only:
`provider_id`, `endpoint_paths_by_wire_family`, `supported_wire_families`, `extra_headers` /
`buildExtraHeaders`, `prePayload`, `prepareRequest`, `credential_forwarding`, `promptCache`,
`gatewayUserAgent`.
`createApiKeyAdapter(spec)` builds the `OpenAICompatibleAdapter`, and `base_url` defaults to
`providerBaseUrl(provider_id)` so the origin has exactly one declaration. `GENERIC_API_KEY_SPECS` (in
`integrations/configured-openai-providers.ts`) covers seven
zero-hook hosts (`groq`, `mistral`, `siliconflow`, `fireworks`, `nvidia`, `gmi`, `ollamacloud`); other
single-file specs add hooks only where needed. `zai/spec.ts` shows the credential-codec variant
(`extractAccessTokenOrRaw` + `credential_forwarding: "never"`).

`integrations/meta.ts` is the spec-only sibling of `muse/`: Meta's Model API is the same `api.meta.ai/v1`
Responses surface and the same `muse-spark-*` catalog, reached with an operator API key from the Meta
developer dashboard instead of the subscription-minted key the Muse device login exchanges for. It therefore
declares no `base_url` (the metadata row owns the origin), imports `MUSE_CODE_MODELS` rather than restating
the roster, and has no `loadAuthentication` — the default key-only credential path plus
`probeApiKeyConnectivity` is the account test.

**Reseller and regional batches.** Most of the catalog is resellers and regional gateways whose whole contract is
an origin, a wire family, and a model list: `integrations/alibaba.ts` holds the four Alibaba key products
(`alicode`, `alicode-intl`, `alims-intl`, `alitp-intl`), because they are the same OpenAI wire on four hosts
and a key issued for one is rejected by the others — a selectable region would hide that. `deepseek.ts`,
`xai.ts`, `cohere.ts`, `together.ts`, `hyperbolic.ts`, `featherless.ts`, `nebius.ts`, `morph.ts`,
`tokenrouter.ts`, `venice.ts`, `bazaarlink.ts`, `llm7.ts`, `baidu.ts`, `tencent.ts`, `volcengine-ark.ts`,
`glm-cn.ts`, `byteplus.ts`, `dahl.ts`, `atria.ts`, `agnes.ts`, `api-airforce.ts`, `kilo-gateway.ts`,
`blackbox.ts`, `poolside.ts`, `vercel-ai-gateway.ts` and `chutes.ts` follow the same shape.
`integrations/minimax.ts` holds the four MiniMax plans: the two coding plans serve Anthropic Messages at
`/v1/messages?beta=true` behind `x-api-key`, and the two agent gateways (`minimax-code`, `minimax-code-global`)
serve Messages behind a bearer token plus a placeholder `x-api-key` and the agent identity headers.
`integrations/perplexity-agent.ts` is Responses-only. Two providers ship no static catalog because their
upstream publishes the roster only through `/models` (`chutes`, `vercel-ai-gateway`); they register an empty
catalog and rely on `loadModelDiscovery`, so Sync fills them.

**The Gemini wire family has three hosts.** `gemini.ts` posts to `generativelanguage.googleapis.com` with
`x-goog-api-key` and a per-model `:generateContent` path. `vertex.ts` reuses that module's
`buildGeminiPayload` and response decoders unchanged and changes exactly two things: the project-scoped path
(`/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`) and the
credential chain — a service-account JSON is signed into an RS256 JWT assertion and exchanged at Google's
token endpoint for a Bearer token (cached per credential, since an assertion lives an hour), an
`authorized_user` ADC JSON refreshes through the same endpoint, and a bare API key rides `?key=` on the
projectless path. `gemini-cli.ts` is a separate adapter because Cloud Code Assist has neither: the model
travels inside a `{project, model, request}` envelope POSTed to the fixed
`v1internal:{generate,streamGenerate}Content` RPC, so the URL carries no model and the auth is an OAuth
Bearer token.

**Vertex's `veo-*` ids are not registered.** They are video generation — `predictLongRunning` plus
`fetchPredictOperation`, a long-running-operation protocol — and this repository has no video wire family.
A `chat` row for a video model would advertise a capability dispatch cannot serve, so the catalog carries
only the five chat ids. Adding video means a new wire family and a job-polling dispatch path, not a catalog
row.

**Bespoke adapters** stay hand-written classes implementing `ProviderAdapter` when the wire is outside the
factory's reach, each carrying a `Factory-blocked` or `Bespoke by wire protocol` header comment naming the
reason: `anthropic.ts` (Messages envelope + `x-api-key`), `gemini.ts` (per-model `:generateContent` RPC +
`x-goog-api-key`), `claude-code/claude.ts` (the assistant CLI fingerprint: Stainless identity headers, beta negotiation, CCH billing, and a persisted per-install `device_id` in `metadata.user_id`), `codex/codex.ts`
(Responses envelope + session headers; `protocol/request/codex.ts` emits tool results from both Chat `tool` and Messages `user` turns as `function_call_output` with the matching `call_id`), `cursor/` and `devin/` (Connect+protobuf), `qoder.ts` (COSY AES/RSA
signing + enveloped SSE), `commandcode.ts` (NDJSON thread/config envelope), `gemini-cli.ts` (Cloud Code
Assist `{project, model, request}` envelope on a fixed RPC path), `vertex.ts` (Gemini payload on a
project-scoped path with a service-account/ADC token chain), `agentrouter.ts`, `cloudflare.ts`
(composite `{apiKey, accountId}` credential), `kimi/kimi.ts` (Messages envelope reusing the shared Claude
pipeline).

`qoder.ts` serves both Qoder sites. The COSY codec — RSA-wrapped AES key, alphabet-scrambled body,
`{statusCodeValue, body}` envelope — is identical between them, so `QoderRegion` selects the host set, the
job-token endpoint, and the model catalog together rather than forking the implementation. The catalogs are
deliberately separate: the CN gateway bills its own Qwen/GLM generation behind `qmodel_38max`, `qfmodel`,
`gmodel` and `gfmodel`, does not carry intl's `qmodel_preview` or `gm51model`, and silently downgrades an
unknown key instead of rejecting it — so a shared catalog would send the wrong SKU without an error.

Qoder's enveloped SSE status codes are normalized inside `qoder.ts` at the integration boundary through the shared
`statusToGatewayErrorCode` table, tagged `origin: "upstream"` because the status came from the provider's own envelope.
The adapter used to keep a private copy of that table which mapped every 5xx to `proxy_unreachable`; that both mislabelled
an upstream outage in the public envelope and degraded the network pool, since `pool-health-machine.ts` treats
`proxy_unreachable` as a pool fault.

| Directory | Shape | Contents |
|---|---|---|
| Single-file (`openai.ts`, `gemini.ts`, `openrouter.ts`, …) | `*_SPEC` or adapter class, plus a `*_MODELS` catalog where the provider ships one (openrouter relies on live discovery) | Whole provider contract; `loadAdapter` imports it directly |
| `claude-code/` | `claude.ts` + `claude-{betas,cch,compatibility,credentials,fingerprint,oauth,quota}.ts` | Header/credential/beta/billing policy split by concern |
| `codex/` | `codex.ts` + `codex-{device-code,errors,headers,identity,oauth,quota}.ts` | Identity + headers + error + OAuth/refresh split; one turn-metadata serialization is reused in the header and request body |
| `cursor/`, `devin/` | dispatch + `catalog.ts` + `*-oauth.ts` + `*-quota.ts` + `generated/` | Protobuf wire; hand-written wiring only outside `generated/` |
| `antigravity/`, `cline/`, `kimi/`, `grok/`, `muse/` | `<name>.ts` + `<name>-{oauth,quota}.ts` (+ `shared`/extra splits where the provider needs them) | OAuth login, quota parser beside the adapter |
| `buddy/` | `codebuddy.ts` + `codebuddy-{cn,oauth,quota,shared}.ts`, `workbuddy.ts` + `workbuddy-{oauth,quota,shared}.ts`, `buddy-{catalog,chat,oauth,quota}-shared.ts` | Tencent buddy family (provider IDs `cb`, `cbcn`, `workbuddy`): cn variant split, per-brand headers, shared Tencent payload/quota/oauth/catalog kernels, plus `buddy-checkin.ts` (daily check-in + growth activity report) for the `daily-checkin` worker |
| `zai/` | `spec.ts` + `zai-quota.ts` | Minimal pair: declarative spec plus one quota parser |

The CodeBuddy family (`buddy/`, provider IDs `cb`, `cbcn`, `workbuddy`) shares `buddy-chat-shared.ts`, `buddy-quota-shared.ts`,
`buddy-oauth-shared.ts`, and `buddy-catalog-shared.ts`. The last owns the seven-field `BuddyRawEntry` tuple
and `makeBuddyModel`, because the intl/CN/WorkBuddy static catalogs describe their rows identically and
differ only in the wire endpoint the row targets (WorkBuddy's base URL carries no version segment, so it
passes `WORKBUDDY_CHAT_PATH` explicitly). Identity headers stay per provider — `codebuddyHeaders` and
`workbuddyHeaders` send genuinely different bytes. All three variants (`cb`, `cbcn`, `workbuddy`) share the upstream chat contract —
mandatory `stream`, `reasoning_summary` only with a `reasoning_effort`, agent-field stripping — and run the same
message-envelope tail (`finalizeBuddyMessages`: coalesce consecutive `user` turns, drop empty-content turns the
upstream rejects with `11151`, guarantee a leading `system` turn for `11128`), so those rules live once. A request
bound for any of the three additionally drops incomplete tool rounds in the preparer (`dropIncompleteToolRounds`):
the buddy gateway rejects a partial batch outright with `11148`, where the generic policy synthesizes an
error-labeled placeholder result for strict Anthropic/Gemini wires. They share the Tencent billing-meter
envelope (`data.Response.Data.Accounts[]`), so `buddy-quota-shared.ts` owns the refill vs bonus split, cadence
labels, and bonus numbering, while each `*-quota.ts` keeps only its endpoint, identity headers, and display
name. Their device-login endpoints answer one `{ data: { accessToken, refreshToken, tokenType, expiresIn } }`
envelope read by `buddy-oauth-shared.ts`. That module owns the whole device login — the state POST, the
token poll that answers the `11217` pending code, the refresh POST, the identity header set, and the JWT
account label — as one `BuddyOAuthClient` parameterized over a `BuddyOAuthVariant`, so each `*-oauth.ts`
holds only its variant: endpoints, domain, platform, user agent, and envelope-code reading
(`strictResponseCode` for CodeBuddy, `coercingResponseCode` for WorkBuddy's gateway, which answers a
looser envelope).

The intl gateway's channel verification rejects any request without the
`X-Conversation-ID` / `X-Conversation-Request-ID` / `X-Conversation-Message-ID` header family
(HTTP 400, code `11128` "conversation id missing") and mirrors the message id in `X-Request-ID`.
The same gate covers WorkBuddy: sending only `x-conversation-id` there is answered with `11128`
"request illegal" plus the "not sent from an official client" tip, which reads like a content
block but is purely a missing-header rejection. `codebuddy-shared.ts` owns that in
`withConversationHeaders`, and both `codebuddyHeaders` and `workbuddyHeaders` route through it:
a caller-supplied inbound
`x-conversation-id` passes through verbatim, otherwise the id derives stably from the canonical
session identity (`stableUuidFrom`, sha1-based v5-shaped UUID) so retries and sibling accounts keep
one conversation; the request/message ids are fresh per dispatch. Code `11128` is overloaded — it
also reports "first message is not system prompt" (a body-shape problem the message-envelope tail
already prevents) — so the error mapper in `src/transport/failure-policy.ts` branches on the message
and names the gate in the failure text instead of leaving a bare `invalid_request`. For the same
reason the account-health classifier excludes `11128` / "channel verification" from the buddy
`policy_blocked` rule: that rule parks a healthy account for 24 hours, which would hide a
header-contract bug behind a "content policy" label.

**Protobuf dirs.** `cursor/generated/agent_pb.ts` and `devin/generated/**` are `buf generate` output
(protoc-gen-es) — never hand-edit; regenerate from the vendor proto source and update `.codegen-stamp` (check
the current prefix with `head -c 8 src/providers/integrations/.codegen-stamp`). Only the adjacent hand-written
modules are edited for those providers.

**Version pins.** CLI-impersonating providers use the shared `operations/client-versions.ts` table (backed by
`createClientVersionResolver` and `provider-version-cache.ts`); each entry defines its key, fallback,
`minVersion` guard, and sources, and resolution is always discovered → pinned fallback so dispatch never
blocks on the npm/vendor lookup. Keep provider-specific fingerprint parsing beside the table only when the
upstream identifier is not a normal version source.

**Where each pinned fallback comes from.** The table below records the lookup for every entry, so refreshing a
pin is a fetch rather than a hunt. `client-versions.ts` is the single source of truth for the *values*; this
table records only *where they were read from*.

| Entry | Source | Read |
|---|---|---|
| `qoder` | `registry.npmjs.org/@qoder-ai/qodercli/latest` | `version` |
| `opencode` | `registry.npmjs.org/opencode-ai/latest` | `version` |
| `commandcode` | `registry.npmjs.org/command-code/latest` | `version` |
| `grok` | `storage.googleapis.com/grok-build-public-artifacts/cli/stable`, then `registry.npmjs.org/@xai-official/grok/latest` | plain-text version, then `version` |
| `clineClient` | `raw.githubusercontent.com/cline/cline/main/apps/vscode/package.json` | `version` (the **extension**, not npm `cline`) |
| `clineSdk` | `registry.npmjs.org/@cline/sdk/latest` | `version` / `dist-tags.latest` |
| `codex` | `registry.npmjs.org/@openai/codex/latest` | `version` |
| `workbuddyClient` | `workbuddy.ai/v2/update?platform=workbuddy-win32-x64-user` | `productVersion` (four-segment build) |
| `workbuddyCli`, `codebuddy` | `registry.npmjs.org/@tencent-ai/codebuddy-code/latest` | `version` |
| `kimiCli` | `pypi.org/pypi/kimi-cli/json` | `info.version` |
| `claudeCli` | `registry.npmjs.org/@anthropic-ai/claude-code/latest` | `version` |
| `claudeSdk` | **no source** — see below | — |
| Antigravity (`antigravity-protocol.ts`) | `antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml` | `version:` line of the electron-builder manifest |
| Devin IDE + extension (`devin.ts`) | `docs.devin.ai/desktop/releases` and the VS Code Marketplace entry `Codeium.codeium` | release list, and the extension's `version` |

The Marketplace entry is queried over its public API — no key needed:

```bash
curl -s https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery \
  -X POST -H "Accept: application/json;api-version=7.2-preview.1" -H "Content-Type: application/json" \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"Codeium.codeium"}],"pageSize":1}],"flags":914}'
```

Two pins cannot be fetched, and both are deliberate:

- **`claudeSdk`** is the `@anthropic-ai/sdk` version *bundled inside* the Claude Code release. The npm package
  is now an ~184 KB installer wrapper (7 files) and the platform packages ship a compiled binary, so no
  metadata states it. Read it from the binary: `ne="<version>"` is the value interpolated into
  `anthropic-sdk-typescript/${ne} userOAuthProvider`. `client-versions.ts` has no `sources` for this entry by
  design — a discovery source would have to parse a ~226 MB executable at runtime.
- **Devin IDE / extension versions** have no manifest: the Windsurf/Devin update endpoints answer 401 or render
  client-side, and the npm packages named `windsurf` / `devin-cli` are `0.0.1` placeholders. The extension
  version comes from the Marketplace query API for `Codeium.codeium` (display name "Windsurf Plugin"); the IDE
  version from the Devin Desktop release notes above, which is the page the download site links to as "View all
  releases". Bump the IDE and extension pins together — they ship as a pair.

Rules: `base_url` comes from `BUNDLED_PROVIDER_METADATA` via `providerBaseUrl()` — adapters that need to
override it (Cline, Grok Build, Muse Code, CodeBuddy, WorkBuddy) set it explicitly, usually to the same
manifest value. Adapters read auth only from
`context.credential`, never ambient config; `anthropic.ts` additionally rejects non-`api_key` credential
kinds. `ensurePayloadModel()` in `integrations/configured-provider.ts` backfills `payload.model` from the dispatch
candidate; a missing model is a 400, never an empty string. OAuth credential JSON envelopes are unwrapped at
dispatch (muse, zai) and never forwarded verbatim when `credential_forwarding: "never"` is set. Adapter test
fixtures live under `test/helpers/provider-dispatch.ts`; this directory holds no test-only module.

## How to extend

Adding a provider — checklist:

1. Metadata row in `provider-metadata.ts` (`id`, `displayName`, `baseUrl` + optionals).
2. Capability entry in `default-registry.ts: PROVIDER_CAPABILITIES` (the `satisfies` record forces it).
3. Adapter module: `createApiKeyAdapter` spec for OpenAI-compatible hosts, bespoke adapter otherwise — prefer
   a single-file `ApiKeyProviderSpec` unless the `Factory-blocked` wire comment applies.
4. Optional `*-oauth` / `*-quota` / discovery modules.
5. Static catalog via `defineModel` (`loadModels`).
6. For CLI-gated upstreams, add the provider entry and fingerprint extractor to `operations/client-versions.ts`.
7. Verify with `bundledModelCatalog()` + `seedBundledModels()` — conflicting endpoint paths throw, which is
   the signal to fix the registration.

Rules: keep provider imports lazy (dynamic `import()` per capability — protobuf adapters must stay off the
startup path); never cache credential-scoped discovery; never reset operator `enabled` in the seeder; never
hand-edit `generated/` protobuf output.

Per-subsystem extension rules: OAuth clients implement `OAuthLoginClient` (or extend `oauth-client.ts`),
register through `loadAuthentication`, and rely on `oauth-refresh-service.ts` — do not build a second refresh
path; declare a JWKS URL as `providerJwtVerification` rather than adding ad-hoc crypto. Simple
percentage-window quotas add `parseQuotaWindows` rows in `integrations/<name>/<name>-quota.ts`; bespoke shapes
write a dedicated parser with the shared guards and return `ProviderQuotaResult`; key-only providers need no
collector — `probeApiKeyConnectivity` is the account test. New discovery paths reuse
`fetchOpenAICompatibleModels` plus `modelsDevCatalog` — refresh the offline `base-models.json` snapshot with
`scripts/ci-generate-models-dev-snapshot.ts` when models.dev data goes stale, and add the provider id to
`MODELS_DEV_PROVIDER_IDS` if its models.dev filing name differs from ours, since the `ModelsDevCatalog` API
stays unchanged — probing and syncing
come free through `ProviderProbingService`. New catalog rows go through the seeder, new cacheable lookups
through `getCachedVersion` / `getCachedModelDiscovery` (never a bespoke `Map` with its own TTL), and new
failure modes through `classifyAccountError` categories — not inline status checks at call sites.
