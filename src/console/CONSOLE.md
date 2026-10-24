# Console

`src/console/` is the management-console control plane: an Elysia API at `/console/api`, the
unauthenticated public share surface (`/share/*`), and the static SPA host (`/`, `/console`,
`/share`). It owns dashboard authentication and every operator mutation, behind per-tenant
access checks, `admin_audit_log` writes, and route-snapshot invalidation so the next `/v1/*`
request sees the change. It never proxies inference traffic.

The console needs Redis (OAuth flow state and the quota cache are Redis-backed), so
it mounts only when a Redis client exists. Sessions are not: they live in
`console_sessions` (Postgres), and CSRF is stateless. Under
`REDIS_MODE=single_instance_local` the process serves `/v1/*`, `/health` and
`/metrics` with no `/console/api/*` and no share surface; `ProductionAppDeps.consoleApi`
is optional for exactly that reason.

## Layout

```text
src/console/
  console-router.ts       /console/api composition root (CSRF + limiter + session guard, and the
                          bearer-API-key fallback for catalog routes)
  dashboard-assets.ts     static SPA host: entry documents for /, /console, /share + CSP/traversal guards
  domain-registration.ts  wires every domain with explicit Drizzle stores + ConsoleDomainContext
  auth/                   cookie sessions, first-boot, lockout, password rotation
  shared/                 cross-domain contract: errors.ts (ConsoleDomainError, requireTenantScope,
                          requireTenantAnyScope for routes two principal kinds reach with different
                          scope vocabularies),
                          query.ts (the one list-limit parser), elysia-schema.ts (literalUnion:
                          projects a canonical runtime tuple into an Elysia t.Literal union)
  providers/              provider + model + account control plane (catalog/ CRUD + /v1/models,
                          detail/ dispatch tuning, oauth/ login flows)
  routing/                operator routing targets (model/ alias+combo, pools/ egress proxies)
  settings/               per-tenant runtime preferences
  prompt-injection/       global / per-key / per-model injected personas (prompt or chat script)
  quota/                  provider-account quota views + refresh orchestration
  domains/                api-keys, studio, live/logs, stats, audit, performance, sse
  cli-tools/              CLI-agent onboarding + host injectors (injectors/ holds the per-tool
                          InjectorSpecs; CONTRACT.md is the spec contract)
  share/                  public enrollment and owner-side shared-key activity
  backup/                 export/restore of config + telemetry metadata, and the router-export
                          importer (nine-router.ts)
  automation/             authenticated root-path proxy to the loopback GrokFarm WebUI
                          (`/automation/*`, enabled by LIANROUTER_AUTOMATION_UPSTREAM; lives at
                          the root, not under /console/api, because the embedded app calls
                          absolute paths)
  tunnel/                 cloudflared quick-tunnel lifecycle (`/tunnel*`) that publishes this
                          gateway publicly and outranks LIANROUTER_PUBLIC_BASE_URL while live
  update/                 launcher-mediated self-update (`/update*`): reads the launcher's
                          run/control.json and proxies its loopback control plane
```

## Conventions

The dominant pattern is **contracts-holds-everything**: `contracts.ts` holds the DTOs, the
`Store` interface, the operations factory, and `create*Routes`, with the sibling `store.ts` as
the Drizzle implementation. `providers/catalog/` splits projections, model operations, and the
read-only `/v1/models` surface into their own files; `providers/detail/` keeps `contracts.ts`
types-only, `cli-tools/contracts.ts` also carries the runtime `TOOL_REGISTRY`/`TOOL_IDS`, and
`providers/oauth/` has no `contracts.ts` at all (`routes.ts` only); `auth/` is the one domain
with none — its
routes live in `session.ts`, its policy and persistence in `service.ts`. `shared/errors.ts` is
the one error/access contract every domain throws through (`ConsoleDomainError` →
`errorResponse`; `requireTenantScope` narrows to a tenant, `requireTenantAnyScope` does the
same for a route reachable by a browser session and a tenant API key whose scope vocabularies
differ); `shared/query.ts` is the one
list-limit parser every `limit` query parameter goes through (`parseQueryLimit`: absent or
empty → the endpoint's default, non-numeric → `invalid_limit`, otherwise clamped to `[1, cap]`).
`shared/elysia-schema.ts`'s `literalUnion` builds a string-literal union from the canonical
runtime tuple that declares those values, so an Elysia body schema is a projection of the one
declaration the TypeScript union and the operations validator read — not a hand-restated copy
that silently falls a member behind.

## The mutation epilogue

Every privileged write records through the domain's `auditSink`, then calls
`snapshotInvalidator.invalidate()` so `/v1/*` dispatch picks up the new revision without a
restart. Covered groups: `providers/catalog` and `providers/detail` (provider, model, account,
routing preference), `providers/oauth` (account creation), `routing/model` and `routing/pools`
(aliases, combos, pools), `cli-tools` slot mappings, `quota` deletes, and `backup` restore (a
committed restore replaces the same routing rows wholesale). Two exceptions:
`settings` and `domains/api-keys` are registered without a snapshot invalidator (their writes
do not change routing), and the tenant-scoped `quota` status flips invalidate the snapshot but
write no audit row — only the global variants and `DELETE /accounts/:id` are audited. Audit is
**fail-open by design** — `AuditRecorder.record` logs failures to
stderr and never blocks the mutation it describes; a routing-visible write that skips
invalidation leaves the data plane stale until restart.

## Auth (`auth/`)

Sessions are opaque hashed DB tokens, not JWTs — the raw secret lives only in the
`session_token` HttpOnly cookie and is never returned in JSON. The domain covers login, status,
refresh, logout, first-boot setup, and password rotation.

Login resolves client identity through the trusted-proxy boundary (503 when the peer address is
unavailable), checks the `identifier:clientIp` lockout key (429 + `retry-after`), verifies the
argon2id hash, and sets session plus CSRF cookies. First-boot setup is gated on `requiresSetup`
(no users exist) and creates the default tenant, platform-admin user, and gateway key in
one advisory-locked transaction with in-process single-flight; change-password rotates the hash
and deletes all other sessions in the same transaction. CSRF is double-submit: login and refresh
set a fresh CSRF cookie beside the session cookie, and logout clears both.

**Login identity.** A console username identifies a user regardless of capitalization:
`ConsoleUserStore.findByUsername` matches with `lower(username) = lower($1)` (not `ilike` — the
submitted value is user input, and `%`/`_` in it must not act as wildcards). Because the unique
index on `console_users.username` is case-sensitive, two rows may differ only by case; that is a
broken invariant rather than a tie to break, so the lookup reads up to two matches and resolves
neither, letting the caller take its ordinary `unknown_user` path. Usernames are **stored as
typed** and matched case-insensitively: first-boot setup writes the operator's spelling verbatim
(it only runs on an empty table, so it cannot collide), and boot reconciliation compares
case-insensitively before deciding to insert the gate user, so it updates a row stored `Admin`
instead of adding a second `admin`. The lockout key is the *other* concern and stays case-folded
(`lowercased-username:clientIp`): one bucket per human, so re-casing the name cannot reset the
failure counter.

**Single-password ownership.** `LIANROUTER_CONSOLE_PASSWORD` seeds the gate but does not own it
forever. `resolveEffectiveConsolePassword` reports which side is authoritative: while the
environment owns it, login compares against that value and boot re-seeds a rotated one; after a
password change from the console, the stored hash wins and boot leaves it alone. Ownership lives
in `console_settings.preferences.consolePasswordManaged`, read through the gate user's own tenant
(never an arbitrary row). The claim also stores a hash of the environment value at claim time
(`consolePasswordEnvFingerprint`); a later mismatch means the operator rotated `.env`, which
releases ownership so the environment value applies again — the recovery path when the console
password is forgotten. A claim with no fingerprint cannot prove the value was unchanged and is
treated as rotated, because the alternative strands the operator outside their own console.

Releasing ownership is scoped to the reconciled tenant (`console_settings` is one row per tenant;
an unscoped update cleared the flag on every tenant at once). Boot reconciliation logs exactly one
`warn` line when it changes something — ownership claimed or released, or the hash rewritten — and
stays silent on the no-op path, which runs on every restart. The line carries the decision and the
tenant id, never a password, hash, fingerprint, or token; the sink is injected so tests record it
without patching the process logger.

The login screen's default-password hint is a claim about a *usable credential*, so it is
`usesDefaultPassword && !consoleManaged`. `resolveConsolePasswordGate` is sync and process-scoped
and cannot read the DB, so `consolePasswordGateWithOwnership` applies the ownership flag the
request already resolved; `/auth/first-boot` therefore hides the hint the moment the console owns
the secret, even when the environment value never changed from the shipped default.

**Invariants.** Session rows store `hashSecret(token)`; the plaintext is handed to the route
once for cookie-setting and never persisted or logged. Cookie and DB expiry share one
`SessionCookiePolicy` (48h, HttpOnly, SameSite Lax, Secure in production or behind a trusted TLS
terminator), and `securePolicyForRequest` honors `x-forwarded-proto: https` only from a peer
inside the trusted-proxy boundary. A malformed or foreign-scheme hash verifies as `false` rather
than throwing — a corrupt row is a counted login failure, not a 500. An unknown user and a bad
password return an identical 401, so account existence is not oracle-able. IP bans
(`security.ip_banned`) are audited best-effort but enforced from the DB row, so a failed audit
write never lifts a ban.

**Two principals, one authorization decision.** The composition root resolves a session cookie
first; when none is present it falls back to a bearer API key, resolved through the same
`resolveApiKeyAuthorization` path `/v1` uses, so scopes and revocation behave identically on both
surfaces. The fallback is deliberately narrow: an absent or unparsable `Authorization` header
means "not a key", the request stays unauthenticated, and the route rejects it with its own 401 —
a browser that sends a stray header is not told its session is invalid. This is what lets a key
register a BYOK upstream or add a model without a browser session. Catalog writes need
`providers:write` / `models:write`, which `dashboard:write` deliberately does **not** imply: a key
minted to change a display setting must not thereby be able to change where traffic goes. The
session is granted the catalog scopes by name (`consoleSessionScopes`) because the dashboard is
the operator; a regular console user holds the read scopes only.

## Providers (`providers/`)

BYOK provider CRUD, per-provider model rows, credential accounts, OAuth login, and per-provider
routing preferences; reads are tenant-scoped (`providers:read`/`models:read`, which the console
session holds alongside `dashboard:read`).

Creates validate the slug (`isBundledProviderId` reserves built-ins), the compatibility profile,
and the wire family; BYOK models in the body are registered and `syncByokProvider` re-registers
the adapter so the provider is dispatchable immediately. Shared (tenant-null) providers are
editable only through the `platform:admin` `/platform/global/:providerId` path, where built-ins
accept enable/disable only. `POST /providers/:providerId/models/sync` is the one catalog
operation that additionally requires `platform:admin` on a tenant-scoped provider, so a plain
`dashboard:write` operator cannot resync their own provider's models. A provider response
also carries `supportedWireFamilies` — the wires that provider may actually serve, derived
by the backend from the registry (built-ins) or the BYOK profile (custom). The dashboard
constrains its Add-Model wire selector to that set instead of re-deriving the rule, so a
Messages-only custom provider can never be driven onto the chat wire. `setModelEnabled` is the hard routing invariant `route-catalog.ts`
filters on: built-in models can be disabled per tenant (`tenantDisabledModels`) but never
deleted (`builtin_model_immutable`). Accounts soft-revoke via `status: disabled` and export
decrypted secrets as a downloaded file, never rendered. OAuth advertises the fixed loopback URI
`http://127.0.0.1:59653/callback`; the server-side console callback remains the exchange
endpoint, so token material never reaches the dashboard.

**Stale global rows are deletable, not adopted.** `seedBundledProviders` only upserts, so a
provider that leaves the bundle keeps its `providers` row with `tenant_id IS NULL`. The tenant
route `DELETE /providers/:providerId` therefore deletes with the same `globalOrOwnedBy`
predicate `list`/`get` read, gated on `!isBundledProviderId` (bundled ids answer
`provider_is_builtin`). This is not a widening of tenant authority: `createProvider` always
writes the caller's tenant id, so a global row whose id is not bundled can only be that kind of
leftover — never another tenant's provider, which stays outside the predicate and answers
`provider_not_found`. Such a row is projected with `stale: true` and the card says it was removed
from the bundle rather than presenting it as a custom provider the operator created. Pruning at
boot is deliberately not done: deleting a provider row cascades its accounts, models, and routing
settings, which would destroy configuration for a removal the operator may not have intended, so
the operator deletes it explicitly through this route.

Per-provider routing preferences (`GET`/`PATCH /providers/:providerId/routing`) are the
operator's own settings, so they live on `provider_routing_settings` rather than on the
`providers` row: a built-in provider's row is seeded and owned by the build, and the console
refuses to write it (`provider_is_builtin`). That is what lets an operator set a system prompt on
a built-in provider — `systemPrompt` is text prepended to every request routed to it, and
`normalizeSystemPrompt` trims it, caps it, and maps an empty value to NULL so a blank field clears
the column instead of storing an empty system message. A tenant row overrides the global
(`tenant_id IS NULL`) row **per field**, not as a whole row, so a tenant that only changed its
strategy still inherits a globally set prompt; `DrizzleProviderDetailStore.getRouting` and
`resolveSystemPrompt` in `transport/routing/route-catalog.ts` read the same chain, so the panel
and the wire cannot disagree.

An account's egress is one of three modes, chosen on create/update and rendered by the dashboard's
per-account **Egress** picker:

- `networkPoolId` set pins the account to one pool. The pool must belong to the caller's tenant
  (`network_pool_not_found` otherwise, checked before the write so a foreign pool cannot route this
  tenant's credential through an address another tenant controls).
- `bypassProxy: true` pins it to **direct** — never a pool, even when the provider's own routing
  routes through the tenant group. This is the per-account override of
  `provider_routing_settings.bypass_proxy`.
- Neither set (the default) joins the tenant's provider-wide pool group.

`null` on `networkPoolId` detaches back to the group, and omitting a field leaves it alone. The two
egress columns are mutually exclusive: a request carrying both is rejected with `invalid_request`,
and a patch that names one mode clears the other in the same write, so the picker's round trip cannot
strand an account on the mode it just left. The response carries the pool **id**, not a label — the
dashboard joins it against the pool list it already loads, so renaming a pool cannot leave a stale
label on an account.

**Invariants.** Account responses never carry secrets; only the export path decrypts, via the
refresh-aware `resolveCredential`, and only for tenant-owned accounts. Compatibility-profile
writes reject unknown fields, adapter-owned headers, and control characters, endpoint paths must
be absolute and CRLF-free, and SSRF-sensitive fields (`credentialUrl`) are presentation-only.

## Routing (`routing/`)

Operator-defined routing targets (aliases and combos) and tenant network pools.

Alias creation rejects self-references, duplicate names, cycles (`aliasCycleExists`, depth 16
matching the engine's `resolveAlias` bound), and targets that resolve to nothing
(`targetResolves` walks alias chains, then combos, then `isKnownModel`). Combo members must each
resolve to a known alias, combo, or model, and nesting is limited to one level
(`combo_nesting_too_deep`) because `RoutingEngine.plan` expands only one level at dispatch;
strategies are `fallback`/`round_robin` only — a rule the `ComboSchemaParity` compile-time check
enforces.

An alias deliberately separates the name a client sends from the model that serves it, and
telemetry keeps both: Request Detail shows `requested_model` as the client-facing name while the
provider/account columns come from the resolved target. A row asking for `claude-opus-5` and
showing `opencodeft` (a CLI mapping or tenant alias at work) is the feature behaving as
configured — not a model copied onto the wrong provider. Resolution order lives in
`TRANSPORT.md` (planning); CLI-mapping variants follow the `cli-tools/` scope gate below.

Discovery applies the same separation. `isModelAllowed` matches a bare allowlist entry against
every qualified form on purpose — "this model, any provider" is the dispatch intent — so
`PublicModelCatalogStore` subtracts the qualified forms itself before publishing `/v1/models`:
when an allowlisted name is an alias or combo, its bare name is the single public entry and every
catalog row whose *bare* name matches is hidden, even when that row nests its own path
(`cline-free/deepseek-v4.1-flash` beside the alias `deepseek-v4.1-flash`). Comparing only the
full `modelId` let exactly those nested rows through, so a key allowlisted to three aliases also
advertised whichever providers happened to nest the same bare names. An explicitly qualified
allowlist entry is an unambiguous grant of that exact row and is never shadowed.

An alias entry mirrors its target's real limits, which means walking the same chain dispatch
walks: an alias usually targets a *combo* name (`muse-spark-1.3` → `muse-pool`), and a combo
member may itself be an alias or combo. Reading only the immediate target finds no catalog row —
a name carries no limits of its own — so the entry fell back to invented defaults (200k/64k) that
understated the route and made a 1M-token pool look like a 200k one. The walk is bounded to 16
hops, matching the engine's `resolveAlias`; a pool advertises the minimum across the ids it can
reach, and only the modalities every member shares, because dispatch may pick any of them.

Pools are CRUD plus health checks that dial a public canary through the pool's real dispatch agent.
HTTP 402 and 407 mean the proxy answered, so checks report `Proxy reachable` with the response
code; because the pool is unusable, it is disabled from routing and the reason is recorded in
`health_events`. The same response during dispatch disables the bound pool instead of flagging
the provider account. Operators must explicitly re-enable it after fixing payment or credentials.
Other transport failures remain `Unhealthy`/`Timeout` and dispatch health is maintained by
pool-bound requests. A successful pooled dispatch recovers degraded/cooldown pools immediately.
Operators can inspect `GET /:poolId/health-events`; mutations release the cached dial agent
(`poolAgentReleaser`), and responses redact legacy secret config keys and surface only
`hasCredential`.

Pool selection strategy is per-tenant (`GET`/`PATCH /strategy`): `least_loaded` (default, absent
row reads as default) or `round_robin`, striding the per-tenant pool cursor by `rotateCount`
(`POOL_ROUTING_STRATEGIES`, `PoolStrategySetting`, `DEFAULT_POOL_STRATEGY`; persisted in
`pool_routing_settings`, read into the route snapshot as `poolRouting`, and applied at dispatch
as `PoolRotation` — see `NETWORK.md` admission and `TRANSPORT.md` routing). Updates validate the
strategy (`invalid_pool`) and clamp `rotateCount` to 1..1000 (`invalid_pool_limits`), record the
`network_pool.strategy_updated` audit event, and invalidate the route snapshot.

**Invariants.** Tenant scoping is enforced at the operations layer (`requireTenantScope`) and
again in store queries (`globalOrOwnedBy` / `ownedByOnly`), and pool endpoints can never point
at loopback or internal hosts. Operators may set `active`/`disabled`; health policy may also
disable a pool after HTTP 402/407. `degraded` and `cooldown` remain health-machine-owned.
Manual checks do not mutate dispatch health except for the explicit 402/407 disable policy.
Credentials are encrypted on write (`encryptCredential`) and never rehydrated on read; only
prefix-length hints leave the store.

## Domains (`domains/`)

- **API keys** (`api-keys/`): list (hides revoked), detail, create (generated `rk_` secret or
  owner-supplied key, hashed via `hashSecret` plus an encrypted copy so share recipients can
  reuse it; secret returned once), patch, revoke (also purges admission state, so a recycled id
  never inherits admission history), and share links (a bearer token whose hash alone is stored).
  A key also carries an optional **egress binding** (`networkPoolId` → `api_keys.network_pool_id`,
  `ON DELETE SET NULL`), which is a *narrowing* constraint on top of the account's own routing:
  `acquirePoolSlot` intersects it with the candidate's pool set, so a key can never widen an
  account's egress. `null`/omitted leaves provider routing untouched, `null` on a patch detaches,
  and `undefined` leaves the column alone. Writes validate the pool through `poolLookup` — a
  tenant-scoped `NetworkPoolStore.get`, not the whole store, because this domain must be able to
  *check* a pool and never to mutate one — rejecting an unknown or foreign id
  (`network_pool_not_found`, 400; a foreign id misses because the read is tenant-scoped, so this
  route cannot probe another tenant's pool ids) and a non-`active` one (`network_pool_inactive`,
  409). The response returns the pool **id**, and the dashboard joins it against the pool list it
  already loads, so renaming a pool cannot leave a stale label on a key. A share template's pool
  is copied onto every child it mints at insert time (see `PERSISTENCE.md`), never resolved
  through the parent at request time.
- **Studio** (`studio/`): CRUD over per-tenant saved sessions (capped, messages and media
  normalized and bounded on write and read), a tenant-scoped `web-fetch` tool over
  the validated outbound network binding, plus a key endpoint that decrypts the tenant's default
  gateway key so Studio traffic flows through the real proxy path instead of a trusted-identity
  bypass.
- **Live** (`live.ts`) reads the process-local in-flight count and per-pool usage
  (`/live/in-flight`, `/live/in-flight/stream`, `/live/pools`, `/live/pools/stream`) —
  `dashboard:read` guard. The global count is process-level; pool usage is filtered by tenant
  ownership. The pool stream emits `pools` inflight snapshots and tenant-filtered `health`
  status/error transitions for the Proxy page.
  `/live/usage/stream` signals that telemetry landed for the caller's tenant, so Usage and
  Overview refetch on real activity instead of a polling timer. It carries no rows — the signal
  says *when* to re-read and the existing usage queries stay the only source of the numbers,
  which keeps one aggregation path. Published from `observability/usage-activity.ts` only after
  `TelemetryBatchBuffer.drain` commits, because a signal sent ahead of the write would make the
  dashboard refetch the pre-batch rows. A `tenantId: null` (global) write reaches every tenant
  since it can move shared aggregates; one tenant's activity never reaches another. On the
  dashboard side `lib/usage-live.ts` owns the refetch policy — which query-key prefixes to
  invalidate and the 1.5 s coalescing window — so `lib/hooks/live.ts` stays a thin EventSource
  wrapper and the policy is unit-tested without a DOM. Three prefixes are invalidated, and all
  three are load-bearing: Overview renders its latency/error/memory figures from `system.health`
  (not from `system.usage`, which only backs its Refresh button), so dropping `system.health`
  leaves the visible numbers on the 15 s poll and the page looks frozen while requests land.
  **Logs** (`logs.ts`) tail `observability/log-ring` with a `level`/`limit` read (cap 500), an
  audited delete, and an SSE stream. **Stats** (`stats/`) serves health, usage, the analytics
  surface, and telemetry events with payloads opt-in; periods are whitelisted by
  `isSupportedUsagePeriod` and client IPs are masked unless the tenant opts into `privacyMode:
  full`. The breakdown is one parametric route (`/system/usage/by-:dimension`) over
  `USAGE_DIMENSIONS` in `domains/stats/usage-periods.ts` — the same tuple the operations validator and the dashboard's dimension
  union read — so a dimension cannot be added to one layer and missed in another. The
  `client_ip` dimension groups on the stored address and masks on read; because masking can
  collapse two hosts into one display name, rows that share a masked name are re-aggregated
  rather than shown twice.
- **Audit** (`audit/`) requires `platform:admin` plus a tenant: the store filters `tenant_id = ?
  OR (tenant_id IS NULL AND platform_admin)` with an opaque `(createdAt, id)` cursor and resolves
  stored actor UUIDs to human names.

**Invariants.** Key secrets and share tokens are returned exactly once at creation; list and
detail shapes never contain them. Telemetry responses pass through `redactTelemetryValue`, and
detail payloads are never included unless explicitly requested. Live/logs/performance expose
instance-level metadata, so they use scope-only guards (`dashboard:read`, or `platform:admin`
for performance) rather than tenant scoping; the audit trail is the reverse — tenant isolation
plus `platform:admin`, since rows carry cross-tenant metadata.

## CLI tools (`cli-tools/`)

Onboarding for external CLI coding agents (the assistant, Codex, Cline, …): registry metadata for the
dashboard, host-filesystem status probes, downloadable config text, and per-tenant model-mapping
persistence. The folder is a classic layered split, with `contracts.ts` holding
`ToolDef`/`ToolInjector`/`InjectorSpec` plus `TOOL_REGISTRY`.

Routes: `GET /registry`, `GET /all-statuses`, `GET /:toolId`, `GET|POST /:toolId/mappings`,
`POST /:toolId/download` (`dashboard:read`), and `POST /:toolId/apply` (`dashboard:write`,
audited as `cli_tool.applied`, invalidating the routing snapshot when it saves a remote route).

`download` and `apply` accept either a pasted `apiKey` **or** a `keyId`. A `keyId` is resolved
server-side by `secret-source.ts` to the tenant's recoverable `api_keys.key_encrypted` copy, so the
operator never has to paste a raw secret to get a config — the plaintext stays on the server and is
written only into the returned config text. A key with no recoverable copy (created before that
column existed) fails with `api_key_unresolvable` rather than silently emitting a blank token, and
resolution is tenant-scoped so one console session can never read another tenant's key.

`apply` has two independent delivery paths and reports which actually ran as `ApplyOutcome`:
`file` writes the tool's config on the host this process runs on (only reaches the CLI when both
share a machine), `remote` persists the source→target rows the gateway applies per `/v1/*` call
(needs no filesystem access, so it works with a containerised or remote gateway), `both`, and
`none` for a guide tool that has no injectable config. Reporting `none` rather than folding it
into `file` is deliberate: the UI must never claim a write that did not happen.

Status reads are host probes (`dashboard:read`) whose `ToolStatus` reports `installed`,
`configured`, settings path, endpoint, key prefix, and models. Slot mappings are validated
against the tool's `defaultModels` aliases, rejecting unknown slots and empty endpoints, then
persisted with removed slots pruned and audited as `cli_tool.mappings_saved`.

Mapping is opt-out at the tenant configuration layer, but **request-time CLI mapping is API-key
gated**: only keys carrying the `routing:cli_mapping` scope may consume these source→target rows,
and keys without it keep normal model/alias routing and are never silently remapped. the assistant family
matching is version-tolerant — a Claude mapping source such as `sonnet` resolves the same family
slot, and the persisted target remains the routed model.

A tool's mapping surface is derived from `ToolDef.mappingMode`, not from a separate flag: only a
`remote` tool (the CLI sends native model names and the gateway reroutes them) has a persisted
mapping table and a per-slot *target*; a `custom` tool writes the routed name into its own config
and has one value per slot; an absent mode means no configurable slots at all. `saveMappings`
rejects a non-`remote` tool rather than silently persisting rows nothing would consume. On the
detail page the two columns read "CLI asks for → LianRouter routes to", an empty target means "not
routed" (only routed slots are persisted), and a target equal to its source is not written.

File-based tools declare an `InjectorSpec` built by `createFileInjector` into a `ToolInjector`
(guide-only tools share `guideInjectorFor`); `INJECTORS` is built exhaustively from the registry,
so a non-guide tool without an injector fails loudly at import. Injectors merge LianRouter fields
into existing configs, reset only injected fields, and use `fs-ops.ts` as their only filesystem
surface. `injectors/CONTRACT.md` pins the house rules for new specs (`import type` for types, no
dynamic imports, merge-never-overwrite, provider name `lianrouter`), and the temp-HOME harness in
`test/helpers/cli-injector.ts` proves the full status → apply → download → reset loop in an
isolated home.

**Invariants.** Status paths never expose full secrets — only an 8-char prefix. There is no
"reveal the key" endpoint: the plaintext is resolved inside the console, used to build a config
body, and never returned on its own. `ApplyInput.apiKey` is never persisted by the CLI-tools layer. Injectors are host-scoped (one process home directory), not
tenant-scoped; only the mappings in Postgres carry a tenant boundary.

## Quota (`quota/`)

Per-account upstream quota views and lifecycle actions, built on each provider's own quota
surface (`fetchProviderQuota`) plus caching and refresh orchestration. The page is a **cache
read**: the `quota-refresh-sweep` task (implemented in `src/workers/quota-refresh-worker.ts`) keeps
cold in the background, and only a genuinely cold single-account read waits on upstream.

The route factory is split by authorisation, because that is the seam the routes already had:
`account-quota.ts` is the composition entry (`createAccountQuotaRoutes`), `account-quota-tenant.ts`
holds the tenant-scoped group (`requireTenantScope` — the caller's own accounts),
`account-quota-global.ts` holds the `platform:admin` group (`requireGlobalAdmin` — tenant-null
shared accounts), and `account-quota-shared.ts` holds only the deps type, the status list, and the
refresh-deps construction that both groups use.

`GET /quota/overview` projects tenant + global accounts with cached quota and health status, and
**never blocks on upstream**: it batch-reads every account's cache per lens and enqueues anything
missing or older than `QUOTA_STALE_AFTER_MS` on a bounded background queue, reporting `refreshing:
<count>` and a per-account `pending` flag so the client can poll fast while the fill runs. Status
flips (`active|degraded|cooldown|disabled`) invalidate the snapshot, `DELETE` also drops the
cached entry and audits `provider_account.deleted`, and the `/global/accounts*` routes are
`platform:admin`-only management of tenant-null shared accounts.

A `status` flip is dispatch eligibility, not a change in the upstream fact the cached quota
describes, so it invalidates only the route snapshot — clearing the cache blanked the card the
user was looking at. A `DELETE` still clears the entry, because nothing can make a deleted
account's quota meaningful again.

The cache (`quota-cache.ts`) is two tiers under `quota:{lens}:{accountId}` with a 300 s TTL — an
in-process `TtlCache` in front of Redis, so quota reads survive a Redis outage. The lens is
deliberately not the tenant: `quotaLens(tenantId)` maps a tenant-null (global/shared) account
onto the shared `GLOBAL_QUOTA_LENS`, since a shared account's quota is the same fact whoever asks
and keying it per tenant meant N fetches for one answer.

Refresh runs through one shared `refreshAccountQuota` (`quota-refresh.ts`) so the single, bulk,
global, background, and sweep paths cannot drift: resolve the credential through the refresh-aware
path (`resolveCredential`, so OAuth tokens refresh before use), call `fetchProviderQuota` (or a
synthetic `missing_credential` result), then `setCachedQuota` under `targetLens(target)` —
**including failures**, because the error view ("credential expired", "quota unsupported") is
itself what the page must render and caching it stops every page open from re-hitting a provider
that just refused us. `recordAccountCheck` never touches `status` or `consecutiveFailures` —
dispatch health owns those, and a manual check only reports.

**Invariants.** Every non-global route is tenant-scoped (`requireTenantScope`) and global routes
require `platform:admin`; account ids outside the caller's tenant simply miss (404), including in
bulk operations. Credentials are resolved server-side and never echoed, and quota responses carry
plan/window metadata only. Stale quota can never outlive the account state it describes: deletes
clear the entry, and the 300 s TTL bounds everything else.

**Daily check-in trigger.** `POST /accounts/:id/checkin` claims the free daily credit grant for one
buddy-family account (`workbuddy`, `cb`, `cbcn` — a Tencent billing-meter pair) and is what the Quota
page's calendar button calls. Anything else answers `checkin_unsupported`. It requires
`dashboard:write`, resolves the credential through the same
refresh-aware path as quota, and forces the status probe (`forceClaim`) while bypassing the sweep's
once-per-day ledger — the upstream stays idempotent, so a duplicate claim answers `already_claimed`,
never a double grant. Success answers the state plus credit (and streak on buddy) with a human
message; only the `error` state is a 502. Tenant scoping matches every other account route: foreign
ids miss with 404.

**Activity report.** `POST /accounts/:id/activity-report` is the sibling growth leg the Quota
page's growth pass calls, covering the same buddy family. It requires `dashboard:write`,
resolves the credential through the same refresh-aware path, and shares the check-in day marker so
the report cannot fire without a claim in the same pass. Because the upstream scores the event by
uid, an OAuth credential is required: a non-OAuth account answers `report_requires_oauth`; an
upstream failure is `report_failed` with a 502.

## Settings (`settings/`)

`GET /settings/runtime` returns the `RuntimeSettingsResponse` enumerated below, with missing rows
mapped to safe defaults (detailed, bounded, masked). `PATCH /settings/runtime` validates
the enums and the concurrency limit (positive integer or `null` to clear), applies a JSONB merge
upsert (`preferences || patch`), bumps the settings revision, and audits `settings.runtime.updated`,
with errors omitting details. Hot paths read narrower slices than the whole row:
`getTenantConcurrencyLimit` feeds the admission service, and the observability store masks client
IPs unless `privacyMode` is `full` (fail-closed: any read error masks).

- `redisModeActual` is environment-derived and read-only; Redis mode is a deployment decision
  (`REDIS_MODE`), so there is no operator-intent counterpart to set.
- `tenantConcurrencyLimit` (default `null`) is the per-tenant admission cap, `null` meaning
  unlimited, read on the request path.
- `thinkingNormalizationEnabled` (default `false`) normalizes provider thinking blocks;
  `responsesReasoningSummary` (default `detailed`) maps effort for the Responses surface.
  `telemetryPayloads` (`bounded` | `none`, default `none`) controls whether short-lived request/response
  bodies are retained for Usage inspection; metadata is always stored, payload capture is opt-in.
- `privacyMode` (`masked` | `full`, default `masked`) makes full client-IP display an explicit
  opt-in, and every reader fails closed to masked.

Writes merge so concurrent PATCHes to different keys do not clobber each other, then
`bumpSettingsRevision()` notifies in-process consumers; the merge only touches whitelisted keys,
so a patch can never inject arbitrary settings. `UpdateRuntimeSettingsRequest` *is*
`ConsoleSettingsPreferences` — the persisted JSONB bag — so the request type, the operations
validator, and the stored shape are one declaration. Adding a preference needs the field on that
bag plus five coordinated edits: the field on `RuntimeSettingsResponse`, the `runtimeUpdateBody`
Elysia schema (whose literal unions project the `RESPONSES_REASONING_SUMMARIES` /
`TELEMETRY_PAYLOAD_MODES` / `PRIVACY_MODES` tuples through `literalUnion`, so they cannot fall
behind the tuples), the mapping in `mapRuntimeSettingsRow`, the whitelist assignment in
`DrizzleRuntimeSettingsStore.update`, and the per-field validator in
`createRuntimeSettingsOperations.update`.

## Backup and restore (`backup/`)

`GET /backup/export` streams a JSON payload as a download and `POST /backup/import` restores one,
auto-detecting whether the file is our own backup (`app: "lianrouter"`) or a router export. Both
re-authenticate the operator's console password rather than trusting the session alone: an export
is the entire configuration in the clear — every provider credential and API-key hash — and an
import replaces it, so a stolen session cookie must not be enough to walk away with the secrets or
overwrite them. The body bound (`MAX_BACKUP_BYTES`) is enforced from `content-length` before the
JSON parse, because the point of the limit is to not buffer an unbounded file.

**Two sections, and the split is the point.** `config` holds the rows that decide where traffic
goes and with which credential; `telemetry` holds per-request metadata plus durable lifetime
account/API-key totals. `telemetry_payloads` — captured prompt/response bodies — is deliberately
never exported and never restorable. A backup is a file that gets copied around, so bodies stay out
of it; a backup is therefore **not** a substitute for a database dump. Export is plain JSON at the
operator's explicit request, so the file is as sensitive as the database and both the layer doc
and the dashboard copy say so.

**A restore only ever touches the restoring tenant's own rows.** `ownershipOf` (`contracts.ts`)
declares, per table, which rows belong to a tenant — `direct` (a `tenant_id` column), `viaParent`
(the row belongs to whoever owns the row it hangs off), `authored` (a table that mixes the
tenant's rows with shared ones, separated by a `source` marker the boot seeder stamps), or `self`
(the tenant row). A table added to `CONFIG_TABLES` without an owner throws instead of being
cleared. Shared rows — the built-in catalog, stored with `tenant_id IS NULL`, and every other
tenant's rows — are outside the restoring tenant's reach; the built-in catalog is not carried in a
payload at all, because the build re-supplies it on boot (`seedBundledProviders` /
`seedBundledModels`).

**Restore modes differ, and the difference is load-bearing.** `config` is replaced for tables
whose every non-tenant row is a shared row the payload re-ensures anyway; a table that mixes in
other tenants' rows, or rows the payload legitimately omits, is `upsert` and never deleted.
`telemetry` is **merged, never deleted**: importing history must not remove rows already present.
Raw events deduplicate by `(tenant_id, request_id, created_at)`. Lifetime totals insert only when
their `(tenant_id, identity_type, entity_id)` is absent, so re-importing an older backup cannot
lower counters already accumulated in the destination. The tenant row is upserted and never
deleted — every tenant-scoped table cascades from `tenants`, including `telemetry_events` and the
console session tables, so replacing it would erase the history this feature preserves and log
every user out.

Legacy monitor/setup link rows are normalized to inactive enrollment rows during
validation, so importing an older backup can never reactivate those public bearer URLs.

**An empty array describes nothing.** A payload naming a table with zero rows must not be read as
"delete everything here" — a config-only file carrying `provider_accounts: []` (a router export
with no connections, an export taken before any account existed) once emptied the tenant's
accounts that way. Clearing happens only for a table the payload actually carries rows for; a
table the payload does not mention is left completely alone, so a partial import cannot empty what
it happens to omit. Restoring a file's silence as a deletion is the failure this rule exists to
prevent.

Every write happens in **one transaction**, and nothing is written until the whole payload
validates: validation resolves every table and column against the live schema, so a stale or
hostile file fails with the offending name and the database is untouched, and a mid-restore SQL
error rolls back rather than leaving half a configuration. A row that carries a `tenant_id` is
checked against the restoring tenant before any write, so a payload lifted from another deployment
fails loudly instead of writing rows that belong to a different tenant; the tenant id comes from
the caller's access decision and never from the request body.

**A committed restore invalidates the route snapshot.** A restore replaces the rows that decide
where traffic goes — providers, models, aliases, and combos among them — so the cached snapshot
describes a catalog that no longer exists the moment the transaction commits. `createBackupRoutes`
therefore calls `snapshotInvalidator.invalidate()` after a successful restore, the same epilogue
every other routing-visible write runs (see "The mutation epilogue" above). Without it the data
plane keeps dispatching the pre-restore routing — a combo whose members were edited still resolves
its old members — until some unrelated console write happens to invalidate. A restore that throws
invalidates nothing, because nothing was committed.

**Restored history and the retention sweep.** `LIANROUTER_TELEMETRY_RETENTION_DAYS` (default 30)
feeds `pruneTelemetry`, so history older than the window is deleted on the next sweep — including
rows a restore just brought back. Retention is left alone (it is a deployment decision), so the
import report and the UI state this plainly rather than letting a successful-looking restore
quietly empty on the next sweep. The export is the real durability story: a backup taken now
preserves history beyond the window, and the operator can keep re-importing it.

`nine-router.ts` converts a router's own database export into a native payload. Two rules shape
it: **never guess** — a provider id with no counterpart is reported as skipped with a reason
rather than mapped onto something that merely looks similar, because silently attaching a
credential to the wrong provider is worse than dropping it — and **never drop silently**, so
everything not imported appears in `skipped` or `warnings` and the report is a complete account
of the file. Credentials are re-encrypted with this instance's key; the router's stored form is
not ours, and a credential is never persisted in the clear.

## Share (`share/`)

API-key rows have two modes. A personal key has an authentication hash and may be used directly;
a share template has no hash or recoverable secret, so it can never authenticate. Only an active
share template can mint an enrollment link. `share-store.ts` stores a SHA-256 token hash and the
`enroll` kind; the bearer token is returned once with a URL built from the authenticated request
origin.

The public `/share/:token` page is served by the single dashboard index. Its `/data` response
contains the template policy, resolved model metadata, and combined usage across every child key
issued by that parent template; it never contains a parent or child credential. The aggregate is
scoped by both tenant and parent id, includes durable request/token totals, a seven-day
retained-telemetry series, top models, and recent request metadata, and excludes the parent key
itself plus children from every other template. Client IPs are always masked on this
unauthenticated surface even when the tenant allows full IPs to authenticated administrators. The
`POST /share/:token/issue` endpoint generates one child key for the client identity resolved
through the trusted proxy boundary. The child copies the parent's scopes, limits, allow/deny lists,
and model prefix.
Only the hash is persisted; plaintext is returned once to the recipient. A database partial unique
index enforces one active shared child per canonical client IP globally, including concurrent
enrollment attempts through different parents.

The owner-side Share page lists child-key prefixes and aggregate hits, errors, tokens, and masked IP
addresses. It polls metadata-only telemetry, shows top models and recent request details, and obeys
the tenant's client-IP privacy preference. Lifetime per-key totals are maintained in
`telemetry_usage_totals`; model breakdowns and request details use retained telemetry and never
include payloads or credentials.

Revoking a share template or converting it back to personal mode atomically revokes every child and
deactivates its enrollment links. Child keys cannot be edited through the personal-key form; owners
revoke them from the Share page. Revoking one child releases its canonical IP for a future
enrollment. Public responses are `no-store` and carry the locked-down API CSP, frame protection,
`nosniff`, and `no-referrer`.

## Tunnel (`tunnel/`)

`GET /tunnel` reads the state, `POST /tunnel/start` starts a cloudflared quick tunnel, and
`POST /tunnel/stop` kills it. Reads take `dashboard:read`; start and stop take
`dashboard:write` and audit `tunnel.started`, `tunnel.start_failed`, and `tunnel.stopped` — the
failure row matters most, since it records who tried to expose the gateway and why it failed.
Start is idempotent (a running tunnel is returned as-is, and concurrent starts share one attempt
so two tabs cannot spawn two children) and bounded: it waits about 25 s for the host in
cloudflared's stderr, and a missing binary, an early exit, or a silent child is a
`tunnel_unavailable` / `tunnel_timeout` 502 after the child is killed. The host is taken from the
quick-tunnel banner only; cloudflared also prints `https://api.trycloudflare.com` in its own
error lines, and advertising that as the tunnel would point every recipient at the API.

**State is process-local, and that is the whole design.** The host belongs to the child
cloudflared process; a gateway restart kills the child, mints a new host on the next start, and
makes the old one worthless. There is therefore no table, no migration, and no entry in
`console_settings` — a persisted URL would advertise an address that stopped resolving the
moment the process that owned it exited. `status().running` is true only once a host is actually
advertised, not merely while a child exists, so the dashboard never offers a host mid-handshake
or after a crash.

**The advertised origin is a layered override.** `src/config.ts` stays a leaf that only reads
`LIANROUTER_PUBLIC_BASE_URL`; `src/runtime/public-base-url.ts` owns the one mutable value and
`resolveEffectivePublicBaseUrl()` returns the live tunnel first, then the configured value, then
`undefined` (request origin). Both call sites that hand an address to a recipient — the
enrollment link in `domains/api-keys` and `apiBaseUrl` in the share payload — read the effective
resolver, so starting a tunnel from the Overview card changes the links without editing `.env`.
A stopped tunnel and a crashed one both clear the override.

**Process handling.** The child is spawned from an argument array (never a shell string) and is
deliberately not unref'd: this process owns it, so an `exit` hook kills it with the gateway, and
its `exit` event flips the status to not-running with an error rather than leaving a dead host
advertised. stderr is drained for the child's whole life, keeping only a bounded tail to scan
for the host — an unread pipe eventually blocks cloudflared. The child's environment is never
logged. The binary comes from `LIANROUTER_CLOUDFLARED_BIN` (default `cloudflared` on PATH).

## Update (`update/`)

`GET /update` reports whether this install can be updated and what the launcher
last saw; `POST /update/start` asks the launcher to begin. Reads take
`dashboard:read`; the start takes `dashboard:write` and audits
`settings.update.started` with the current version as the target and the offered
version in `detail`.

**The launcher is the only writer.** The gateway cannot install an update: it
does not own its binary, it cannot replace a file it is executing, and it is
stopped in the middle of the operation. The launcher owns the install tree and
the supervisor, survives the gateway being stopped and replaced, and publishes a
loopback control plane in `<installRoot>/run/control.json` (`{port, pid,
startedAt, token}`, mode `0600`). The launcher injects
`LIANROUTER_LAUNCHER_HOME` into the gateway child; this domain reads that
variable, reads the handshake, and calls
`http://127.0.0.1:<port>/update/state` and `/update/start` with
`x-lianrouter-control: <token>`.

**The token never reaches the browser.** It exists so that reaching the port is
not the same as being allowed to command the launcher, and it stays inside
`launcher-client.ts` — no response in this domain carries it. The handshake is
re-read on every request and never cached: the launcher mints a new port and
token per boot, so a cached pair would outlive a launcher restart and dial a
socket nobody owns. A missing env var, a missing file, a malformed field, or an
unreachable port all collapse to `launcher: false` rather than an exception —
"no update control" is a state the dashboard renders, not a failure it reports.

**Progress survives a gateway restart.** An update stops the gateway, replaces
the binary, and starts it again, while the launcher keeps running. The console
tab that reconnects afterwards would otherwise see a fresh process with no
memory of the update it was watching, so the launcher keeps the snapshot, the
last progress frame, and a `running` flag in its own memory and serves them from
`GET /update/state`. A second start while one is running is refused with
`409 update_in_progress` instead of racing the install; a start with no launcher
is `503 launcher_unavailable`; a launcher that answers anything else is
`502 launcher_error` carrying its own message.

The wire shape is the dashboard's contract:

```json
{ "launcher": true, "current": "2.0.0", "latest": "2.0.5", "available": true,
  "notesUrl": "https://…/releases/tag/v2.0.5", "publishedAt": "2026-10-20T10:00:00Z",
  "running": false, "progress": null }
```

`latest`, `notesUrl`, and `publishedAt` are `null` when unknown; `available` and
`launcher` are both `false` when no launcher is attached; `progress` is `null` or
`{ phase, percent, message, bytesReceived, bytesTotal, error }` with the three
trailing fields `null` when absent. `phase: "error"` carries the reason in
`error`.

## Automation proxy (`automation/`)

`/automation/*` reverse-proxies the loopback GrokFarm WebUI (a FastAPI control plane for Grok
account registration) when `LIANROUTER_AUTOMATION_UPSTREAM` is set; unset keeps the route 404 and
hides the dashboard's Automation nav entry. The route lives at the **root**, mounted in `app.ts`
beside the share router, because the embedded app calls absolute paths (`fetch('/api/config')`)
that a `/console/api` prefix or `<base>` rewrite cannot capture. Since the console middleware only
guards `/console/api/*`, each request resolves the session itself via `resolveConsoleAccess`;
unauthenticated requests redirect to the console login. Request cookies are never forwarded and
response CSP/frame headers are stripped and re-imposed (the upstream is loopback-only and
untrusted); the upstream URL must be loopback or config validation rejects it.

## How to extend

- **New console domain:** DTOs + `Store` interface + operations + routes in
  `domains/<name>/contracts.ts`, a `store.ts` behind a narrow interface, registered in
  `domain-registration.ts` with `accessResolver` + `auditRecorder` + `snapshotInvalidator` where
  the mutation affects routing.
- **New provider surface:** extend `providers/catalog/` or `providers/detail/`, never bypassing
  the `Drizzle*Store` boundary. New operations follow the `create*Operations` factory shape
  (`access` first, `requireTenantScope`/`requireGlobalAdmin` up front) and new routes the
  try/`errorResponse` wrapper; a login-capable provider needs an `OAuthLoginClient` in the
  provider registry — the OAuth routes resolve clients dynamically, so no route changes are
  required.
- **New read-heavy resource or live feed:** mimic `stats/` — DTOs and
  `create*Operations`/`create*Routes` in `contracts.ts`, Drizzle aggregation in `store.ts` behind
  a narrow store interface, period/cursor validation up front. A live feed reuses
  `domains/sse/routes.ts`
  (`createConsoleSseStream` + `consoleSseResponse`) on the `live.ts`/`logs.ts` pattern: guard,
  send the snapshot, return the subscriber teardown.
- **New alias/combo rule or transport kind:** `routing/model/contracts.ts` beside
  `aliasCycleExists`/`targetResolves`, persisted in `routing/model/store.ts` behind
  `ModelRoutingStore`. A
  new `TransportKind` needs a `validateTransportConfig` case (exhaustiveness is compile-time
  checked), a `deriveKind`/`splitEndpointConfig` mapping in `routing/pools/store.ts`, and
  `network/pool`
  agent support.
- **New CLI tool:** a `ToolDef` in `TOOL_REGISTRY`; file-based tools add a spec per
  `injectors/CONTRACT.md` and register in `FILE_INJECTORS` (module-private in
  `injectors/driver.ts`, surfaced via the exported `INJECTORS` map; guide-only tools need no
  injector code, and the registry stays presentation metadata only).
- **New quota action or share data:** reuse `refreshAccountQuota` (provider-specific parsing
  belongs in `src/providers/quota/`); account controls expose the stored per-account concurrency
  override beside the same account's today and lifetime usage totals. Share activity is shaped by
  `share-usage.ts` from retained metadata plus durable lifetime aggregates, with raw payloads and
  credentials excluded.
