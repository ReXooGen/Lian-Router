# LianRouter

<img width="1760" height="576" alt="LianRouter — one gateway for every AI provider" src="dashboard/public/og_image.webp" />

**A self-hosted AI gateway that speaks every client protocol and every provider
dialect — so you configure a route once, and any client can reach any model.**

This repository is the **local, self-hosted build**: one process, one PostgreSQL
database, and the console on `http://localhost:12800`. It is meant to be cloned
and run on your own machine or LAN — there is no hosted service, no account, and
no shared infrastructure behind it.

LianRouter sits between your AI clients and your provider accounts. It accepts
the wire formats real tools already speak, normalizes every one of them into a
single canonical request, then routes that request across provider accounts and
models under admission control, capability checks, health tracking, and
validated egress.

The result is one endpoint, one key, one console. Point Claude Code, Codex,
Cursor, or any OpenAI-compatible client at it, and let the gateway work out which
account serves the request, whether the provider can express what the client
asked for, and what to do when it cannot.

Built with Bun, TypeScript, Elysia, PostgreSQL, and optional Redis coordination.

> **Credit.** LianRouter is a router built from **Cartethyia**, the self-hosted
> AI gateway this project started from, and modified for personal use. The
> routing engine, provider integrations, and console architecture come from that
> upstream. This fork is rebranded, trimmed to a console-only distribution, and
> configured for local use.

## Screenshots

These are the real console screens, captured locally at
`http://localhost:12800` against a fresh install. Every value shown is sample
data from a throwaway local instance — no operator credentials, provider keys,
API tokens, or production endpoints appear in them.

### Overview

![Console overview: gateway endpoint, system health cards, and API credentials](docs/screenshots/overview.jpg)

### Usage

![Usage analytics with totals, traffic chart, and recent requests](docs/screenshots/usage.jpg)

### Providers

![Provider catalog with bundled integrations and account counts](docs/screenshots/providers.jpg)

### Proxy & Requests

![Egress pools with status, inflight capacity, and health checks](docs/screenshots/proxy.jpg)

### Combos & Routes

![Model combos and aliases](docs/screenshots/combos.jpg)

### Settings

![Runtime settings and backup/restore](docs/screenshots/settings.jpg)

### Console Log

![Live console log](docs/screenshots/console-log.jpg)

## Highlights

- **40 bundled provider integrations** — OpenAI, Anthropic, Codex, Gemini, Grok,
  Cursor, Devin, Mistral, Groq, OpenRouter, Cerebras, NVIDIA, Cloudflare,
  DeepSeek-family gateways, and more, each with its own authentication, wire
  quirks, and identity headers.
- **Four client protocols, one canonical model** — Chat Completions, Responses,
  Messages, and legacy Completions all normalize into the same request shape.
  A client's protocol is a property of the connection, not of the route.
- **Capability-aware routing that translates instead of rejecting** — when a
  chosen model cannot express something the client asked for, the request is
  degraded in place (generation controls dropped, media replaced by placeholders)
  rather than silently rerouted to a model you never asked for.
- **Account health as a state machine** — every failure is classified into
  `active` / `degraded` / `cooldown` / `disabled`, with per-account and per-model
  backoffs, automatic recovery, and a full transition log you can read.
- **Validated egress pools** — HTTP CONNECT, HTTPS CONNECT, and SOCKS5, with
  SSRF validation at both creation and connection time. Configured pool failures
  surface as failures; a request never silently falls back to direct egress.
- **Multi-tenant by construction** — scoped personal API keys, non-authenticating
  share templates that enroll one child per trusted client IP, model allow/deny
  policies, and per-key rate and token budgets.
- **Observability you can act on** — per-request telemetry, bounded and redacted
  payload capture, Prometheus metrics, a live console log, and JSON export /
  import for moving configuration between deployments.

## Supported client protocols

Each surface below has a real handler, codec, and test suite behind it. The
gateway accepts a client's own wire format and normalizes it — the protocol is a
property of the connection, not of the route you configure.

| Surface | Path | Notes |
|---|---|---|
| Chat Completions | `/v1/chat/completions` | The broadest compatibility surface |
| Responses | `/v1/responses` | Native for Codex; reasoning, tools, hosted tools |
| Responses compact | `/v1/responses/compact` | Native Codex compaction |
| Messages | `/v1/messages` | Anthropic-native; what Claude Code speaks |
| Completions | `/v1/completions` | Legacy text completion |
| Embeddings | `/v1/embeddings` | OpenAI-shaped vectors; non-streaming only |
| Models | `/v1/models` | Read-only catalog listing (`/v1/models/info` for detail) |

Anything else under `/v1/` is not routed. A path the gateway does not serve
returns `404` with `{"error":{"code":"not_found"}}` rather than being forwarded
upstream, so a typo surfaces immediately instead of reaching a provider.

Requests authenticate with either `Authorization: Bearer <key>` or
`x-api-key: <key>`. Sending both is rejected rather than resolved, so a client
cannot be ambiguous about which credential it meant.

## Request lifecycle

Every request walks the same path, which is what makes the behavior predictable:

```text
ingress (single body read)
  → ordered pipeline (readiness → identity → IP-abuse → API-key auth
                      → canonical parse → route prepare)
  → plan (alias → combo → ambiguity → eligibility → capability filter
          → provider-routing reorder)
  → leases (admission → pool slot → reservation)
  → provider adapter dispatch (stream primed before the 200 commits)
  → completeAttempt (usage, health, capture, exactly one telemetry row)
```

Routing, admission, retry, accounting, and telemetry are shared across every
surface — a `/v1/messages` request and a `/v1/chat/completions` request travel the
same path once they are canonical.

## Requirements

- Bun 1.4.2
- PostgreSQL (local or reachable on your network)
- Redis for `REDIS_MODE=normal`
- Node-compatible development environment for tooling

PostgreSQL is external in native and Docker setups. Redis is optional when using
`REDIS_MODE=single_instance_local`, which is the simplest setup for a single
machine.

## Run it locally

The whole path from a clone to a working console:

```bash
bun install
cp .env.example .env
```

Edit `.env` and set at least:

```text
DATABASE_URL=postgres://postgres:<password>@localhost:5432/lianrouter
LIANROUTER_ENCRYPTION_KEY=<64 hex characters>
```

Generate the key with `openssl rand -hex 32`, or
`bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep
it: it encrypts stored provider credentials, and losing it makes them
unreadable.

Then add the console password. This is the only credential that opens the
console — there is no username and no account setup:

```text
LIANROUTER_CONSOLE_PASSWORD=local-console-2026
```

That is the password a fresh install ships with, and the login screen prints it
while it is still in use. Replace it with your own value: the hint disappears as
soon as the configured password is no longer the default.

```bash
bun run setup     # creates the schema and seeds the provider catalog
bun run dev       # backend + console on http://localhost:12800
```

Open `http://localhost:12800/`; the root redirects into `/console/` and asks for
that password. Nothing leaves your machine unless you add a provider account and
route a request through it.

`LIANROUTER_CONSOLE_PASSWORD` is the **initial** password. You can change it
from Settings → Security Controls: the console stores only an argon2id hash, and
that hash becomes authoritative, so the new password survives a restart. This is
what lets a public deployment set its own password without shell access to
`.env`.

To take the password back from the console — including when you have forgotten
it — change `LIANROUTER_CONSOLE_PASSWORD` and restart. A changed environment
value reclaims ownership and is applied on the next boot; an unchanged one
leaves the console-managed password in place.

The password is never stored in plaintext, and no environment value is copied
into the database: a database dump carries only a hash. Leave
`LIANROUTER_CONSOLE_PASSWORD` unset to fall back to per-user accounts with a
first-boot setup wizard — that mode is for a deployment shared by several
operators.

`bun run dev` runs the stack behind a supervisor proxy on that same port: press
**CTRL+R** in its terminal to restart backend + dashboard in place — client
requests arriving during the restart gap are held (added latency, no
`connection refused`) until the backend is listening again. **CTRL+C** stops
everything. `bun run dev:stack` runs the raw stack without the supervisor.

Useful endpoints:

```text
/health       liveness
/health/ready readiness
/metrics      Prometheus metrics
/v1/*         gateway APIs
/console      admin console (root redirects here)
/share/:token public child-key enrollment
```

## Console

This build ships the console only. The gateway serves no public marketing page:
`GET /` redirects to `/console/`, and the console is the entire browser surface.
The console covers the whole operational surface:

- **Overview** — traffic, success rate, latency, and provider health at a glance
- **Usage** — per-request telemetry with request detail and payload inspection
- **Providers** — accounts, credentials, health, per-account in-flight limits,
  today/lifetime token usage, and per-model probing
- **Model Lab** — exercise a model directly and see the raw exchange
- **Combos & Routes** — model combos, aliases, and CLI-tool mappings
- **Quota Management** — account quota, check-in state, and refresh control
- **Proxy & Requests** — egress pools, reachability tests, and dispatch history
- **CLI Tools** — map a coding agent's model slots onto your own routes
- **Customization, Console Log, Settings** — runtime configuration, live logs,
  and backup/restore

Access is a single password (`LIANROUTER_CONSOLE_PASSWORD`) in front of the
whole console, so opening the dashboard never exposes the router without it.
The same secret gates the console API: every page, every mutation, and the
backup export/import flows sit behind it.

## Configuration

`.env.example` is the configuration reference. Required values for a real run:

```text
DATABASE_URL
LIANROUTER_ENCRYPTION_KEY
LIANROUTER_PUBLIC_ORIGIN
REDIS_URL                    # unless REDIS_MODE=single_instance_local
```

When the gateway runs behind a reverse proxy, set `TRUSTED_PROXY_CIDRS` to the
proxy's CIDRs (for a loopback proxy, `127.0.0.1/32,::1/128`). Without it the
gateway sees every visitor as the proxy's own address, which collapses the
per-client-IP rules — share-link enrollment in particular — onto a single
identity. Leave it unset when nothing sits in front of the gateway, so a client
cannot forge its own address.

The environment drift test keeps literal `process.env.*` reads documented:

Per-tenant runtime settings control request-body capture: `telemetryPayloads`
defaults to `bounded` (redacted, size-limited, 15-minute TTL) and `none` is the
kill-switch for new payload rows. The active environment template also exposes
the local `.jsonb` backing-store directory, file-size bound, and retention
override.

```bash
bun test test/config-env-drift.test.ts
```

## Development commands

```bash
bun run dev
bun run dev:backend
bun run dashboard:dev
bun run setup
bun run doctor
bun run typecheck
bun run dashboard:typecheck
bun run dashboard:build
bun run build:aot
bun run build:binary
bun run build
```

`bun run build` produces the standalone binary in three steps: build the
dashboard assets, run the Elysia AOT precompile into `dist/main.js`, then
compile that output into `dist/lianrouter`. The binary step reads the AOT output
rather than `src/main.ts` — the AOT pass rewrites TypeBox into statically wired
imports, and bundling the raw source instead leaves an unresolvable
`require("typebox/type")` in the executable. It also bakes `NODE_ENV=production`
into the artifact, which the binary needs in order to find `<cwd>/migrations`
and to avoid the development-only pretty-print log transport.

The compile target defaults to the host platform. Deploying to a different one
requires naming it, because the default silently produces a binary the server
cannot execute:

```bash
bun run scripts/build-binary.ts --outfile dist/lianrouter --target bun-linux-x64
```

## Tests and coverage

Tests live under the root `test/` tree. Backend tests mirror the production
layout; cross-cutting suites are grouped under `test/contracts`,
`test/integration`, `test/architecture`, and `test/frontend`.

```bash
bun run test
bun run test:contracts
bun run test:integration
bun run check:coverage
```

The offline coverage gate requires at least 75% line coverage for handwritten
backend `src/` code. DB-gated tests may be skipped when
`LIANROUTER_TEST_DATABASE_URL` is not configured; when it is, the suite runs
against that database and leaves `DATABASE_URL` alone.

## Docker

```bash
docker compose up --build -d
docker compose logs -f app
docker compose down
```

The Docker image builds the dashboard and compiled backend, runs as a dedicated
non-root user, and exposes port `12800`. PostgreSQL must be reachable through
`DATABASE_URL`; Compose manages Redis only.

### Moving a configuration between machines

The application applies its migration baseline at boot, so a new database needs
no manual step — but a database that already existed before a baseline change
may need the hand-run statements under `drizzle/migrations/manual/`. Those are
never applied automatically; their headers say so, and they are idempotent.

To move your configuration to another machine, use **Settings → Backup** in the
console:

1. On the old machine, export a backup. It downloads as plain JSON and contains
   every provider credential and API-key hash, so treat the file as secret.
   Export requires the console password.
2. On the new machine, start LianRouter against an empty database and wait for
   `/health/ready` to return `200`. Boot creates the schema and seeds the
   bundled provider catalog, which the import depends on.
3. Import the file there. It re-authenticates the same way.

A backup carries a tenant's own configuration and its request telemetry, not the
shared built-in catalog (the build re-supplies that) and not captured
prompt/response bodies. Restore replaces the importing tenant's config rows,
merges telemetry without duplicating it, and cannot touch another tenant's rows.
It is not a substitute for a database dump.

## Providers and egress

Provider integrations live under `src/providers/integrations/`. Generated
protobuf output consumed by Cursor and Devin integrations is committed under
their integration directories.

Supported network pool transports are:

- HTTP CONNECT
- HTTPS CONNECT
- SOCKS5

Pool endpoints are SSRF-validated at creation and connection time. Configured
pool failures are surfaced; requests do not silently fall back to direct egress.

## Generated protobuf

Cursor and Devin integrations consume committed protobuf output under their own
integration directories (`src/providers/integrations/*/generated/`). It is
build input: normal typecheck, build, setup, and Docker build read it as-is and
never regenerate it, so none of them need Buf, network access, or external code
generation. Regenerating is a separate, deliberate step.

## Repository map

```text
src/        production backend
 test/      backend and contract tests
 dashboard/ React/Vite dashboard (route and browser-boundary map in `dashboard/README.md`)
 scripts/   flat operational scripts
 drizzle/   database migrations
```

For repository-local coding conventions and cleanup rules, see `AGENTS.md`.
