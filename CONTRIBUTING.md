# Contributing to LianRouter

Setup, workflow, and the checks your pull request must pass. This is the
human-facing companion to `AGENTS.md` (agent repo rules) and `ARCHITECTURE.md`
(code map) — those stay authoritative for their topics and are linked, not
duplicated, below.

## Prerequisites

- Bun 1.4.2 (see `.bun-version`; Docker pins `oven/bun:1.4.2-debian`)
- PostgreSQL (external in every mode — native and Docker alike)
- Redis for `REDIS_MODE=normal`; optional for `REDIS_MODE=single_instance_local`
- A Node-compatible environment for tooling

## Local setup

```bash
bun install
cp .env.example .env
# Edit DATABASE_URL and LIANROUTER_ENCRYPTION_KEY in .env.
bun run setup     # copies .env if missing, probes Postgres/Redis, runs migrations
bun run doctor    # re-checks the environment and /health/ready
bun run dev       # supervisor proxy + backend (bun --hot) + dashboard (Vite); CTRL+R = restart in place
```

Useful endpoints once running (`http://localhost:12800` by default):

```text
/health        liveness
/health/ready  readiness (DB + migrations + Redis)
/metrics       Prometheus metrics
/v1/*          gateway APIs
/console       dashboard
```

`bun run dev:backend` and `bun run dashboard:dev` run each half separately.
`bun run dev` itself is a supervisor (`scripts/ops-dev-supervisor.ts`): it
binds the public port and reverse-proxies to the backend on an internal port,
so **CTRL+R** restarts the whole stack in place while incoming requests are
held until the backend is back — clients see latency, never a refused
connection. **CTRL+C** stops everything; `bun run dev:stack` runs the raw
stack without the supervisor. Advanced knobs (`DEV_PROXY_PORT`,
`DEV_BACKEND_PORT`, `DEV_SUPERVISOR_CMD`, `DEV_HOLD_MS`) are documented in
the script header.
`VITE_BACKEND_URL` (see `.env.example`) points the Vite dev server at the
backend. Production serving is covered in `README.md` (Docker Compose).

## Running tests

DB-dependent suites gate on `LIANROUTER_TEST_DATABASE_URL` pointing at an
**isolated** Postgres database (`test/helpers/db-gate.ts`): with the variable
set they run, without it they skip with a `[db-gate] skipped` note. The same
helper also routes the process at that database, because `getDb()` resolves
`DATABASE_URL` — the gate overwrites it before any pool is opened. A DB suite
therefore never touches your working database, and you do not need to align
`DATABASE_URL` with the test URL by hand. Skips are expected locally — report
them separately from failures in your PR.

```bash
bun run test                 # full backend suite (DB suites skip without the URL)
bun run test:contracts       # cross-cutting contract suites
bun run test:integration     # integration suites
bun run check:coverage       # coverage gate: 75% offline, COVERAGE_MIN=80 with DB

bun run scripts/ops-run-tests.ts test/console                     # one subtree
bun run scripts/ops-run-tests.ts test/providers/integrations/codex

bun run dashboard:test        # dashboard (Vitest/bun) suite
```

## Verification gate (required before every PR)

From `AGENTS.md` — backend change:

```bash
bun run typecheck
bun run test
bun run check:coverage
```

Dashboard or API-contract change, additionally:

```bash
bun run dashboard:typecheck
bun run dashboard:test
bun run test:contracts
```

CI (`.github/workflows/ci.yml`) runs exactly these gates with Postgres +
Redis services and `COVERAGE_MIN=80`. Typecheck and build never require Buf,
vendor protobuf sources, or network access.

## Code conventions (short version)

Full rules live in `AGENTS.md`. The points that most often bite new
contributors:

- `src/` is production code only — no `*.test.ts` there; tests live in
  `test/` mirroring `src/`.
- No `index.ts` barrels; import concrete files. `import type` for type-only
  imports. Strict TypeScript: no `any`, no suppression directives, no
  needless assertions; prefer `unknown` + narrowing at boundaries.
- Entity directories use role filenames: `contracts.ts` (types + validation
  + operations + routes), `routes.ts`, `store.ts`, `service.ts`, `errors.ts`.
- `scripts/` is flat with role prefixes (`ops-*`, `build-*`, `ci-*`).
- Comments explain policy, security, or non-obvious tradeoffs — not what the
  next line does.
- Tests assert observable behavior, boundaries, errors, transitions, or
  security invariants — never implementation details or source text (unless
  the contract is about a layout/config rule, like `test/architecture/`).
- Never delete a test just because it is old or moved; replace lost contract
  coverage when you remove one.

- Each top-level `src/` folder documents its whole subtree in one layer doc
  beside it, named for the layer (`src/transport/TRANSPORT.md`) — subfolders do
  not carry their own; `ARCHITECTURE.md` is only the map linking to them. If your change adds a layer, route group, provider
  capability, env var, or DB table, update the corresponding top-level doc
  (and `.env.example` for env vars, `drizzle/` + `src/persistence/schema.ts`
  for tables). Adding or renaming a top-level folder doc also updates the
  `ARCHITECTURE.md` table.
- `README.md` + `.env.example` are product/runtime docs; `AGENTS.md` is
  agent-only rules; `CHANGELOG.md` entries under `Unreleased` stay historical
  once written. Keep all four synchronized with the source you change.
- Anti-drift rules (what must change together, what must never be recorded
  in docs, and what to do when doc and code disagree) live in
  `AGENTS.md` under "Documentation and configuration currency" — read that
  section before touching any doc.

## The launcher package

`cli/` is a separate package with its own `package.json` and `tsconfig.json`, and
it is not compiled by the root `tsc --noEmit` (the root config includes `src`,
`test`, and `scripts` only). Typecheck and build it from its own directory with
`bun run --cwd cli typecheck` and `bun run build:cli`; its behavior, install
layout, and extension points are documented in `cli/CLI.md`. A change that
crosses the process boundary — a new control route, a new update phase — updates
that doc in the same change, because nothing in `src/` describes the launcher.

`bun run build:cli` emits both bundles (`cli/dist/cli.js` for the `bin`,
`cli/dist/tray.js` for the tray host). It is invoked by `prepublishOnly`, so
every path in `scripts/build-cli.ts` is anchored to the script's own location
and the build pins its bundling cwd: running it from the repository root and
running `bun run build` inside `cli/` produce byte-identical output.

The launcher does not ship the gateway. `bun run build` produces the binary and
the dashboard, and `bun run build:release` (`scripts/build-release.ts`) stages
the gateway executable, `migrations/`, and `dist/dashboard/` flat and zips them
into `dist/release/lianrouter-<platform>-<arch>.zip`. That archive is the
contract the updater and the first-run bootstrap consume: `pickAssetForPlatform`
selects it by exact `platform-arch` token, and the bootstrap asserts the binary
lands at the archive root. The script prints the archive's sha256 — a release
asset without a digest is refused by the install path, so the digest must be
attached to the GitHub release asset.

## Cutting a release

A release ships three artifacts that must agree, in an order that is not
arbitrary. The sequence below is the one the install path enforces; running it
out of order produces a published launcher that cannot install the gateway it
was built to supervise.

1. **Bump the version in every manifest that carries it.** The three numbers are
   read independently at runtime, so a mismatch surfaces as three different
   version strings in the same session:
   - `package.json` — the gateway. Read by `src/transport/version.ts` as
     `LIANROUTER_VERSION`, which is what `/v1/*` responses, metrics, and
     metadata helpers advertise.
   - `cli/package.json` — the launcher. Read by `cli/src/version.ts` as
     `CLI_VERSION`, which drives the menu header, `--version`, and the update
     comparison.
   - `dashboard/package.json` — the console. Read by
     `dashboard/src/lib/version.ts` as `DASHBOARD_VERSION`, which renders the
     brand version badge.

   Then run `bun install` with no flags. `bun.lock` records the version of each
   workspace package (`cli`, `dashboard`) alongside its dependency set, so the
   three edits above leave the lockfile stale and `bun install --frozen-lockfile`
   — the exact command both CI jobs run — fails with a lockfile mismatch before
   any check executes. Commit the refreshed `bun.lock` in the same commit as the
   manifests and confirm `bun install --frozen-lockfile` exits 0.
2. **Build the gateway, then the release archive.** `bun run build` produces
   the binary, the AOT bundle, and `dist/dashboard/`. `bun run build:release`
   (`scripts/build-release.ts`) stages the gateway executable, `migrations/`,
   and `dist/dashboard/` flat and zips them into
   `dist/release/lianrouter-<platform>-<arch>.zip`, printing the archive's
   `sha256`. The packager refuses a slice whose binary is missing rather than
   leaving a half-staged archive, so cutting a release for a non-host platform
   means running the gateway build on that platform (or a matching cross-build
   host) and running `build:release` there — one host cannot package a slice it
   did not build.
3. **Create the GitHub release before touching npm.** The tag is `v<version>`
   (the update source reads `tag_name` as-is; `normalizeVersion` strips the
   leading `v` on compare). Upload every platform archive under its exact
   `lianrouter-<platform>-<arch>.zip` name — `pickAssetForPlatform` in
   `cli/update/github-source.ts` matches by exact `platform-arch` token and
   prefers `.zip`, so a renamed, re-compressed, or nested asset is simply not
   seen. Each uploaded asset must carry a `sha256:<hex>` digest matching the
   value `build:release` printed; `cli/src/bootstrap.ts` fails closed on an
   asset with no digest rather than installing unverified bytes, so a release
   whose assets were uploaded through a path that did not record a digest is
   installable by nothing.
4. **Publish the npm package last, from `cli/`.** Only after the GitHub release
   is published and its assets carry digests: `cd cli && npm publish` (the
   `prepublishOnly` script rebuilds the bundles; `publishConfig.access` is set
   to `public`, so no flag is needed). Publishing first is what breaks first
   run — the launcher that ships to the registry has no gateway bundled, so a
   fresh install runs `lianrouter`, finds nothing in the install root, asks the
   release feed for an asset, and raises `GatewayNotInstalledError` because the
   release the launcher was cut for does not exist yet. The package is
   technically installable and functionally unusable until the release lands.
5. **The version only moves forward.** npm refuses to republish a version that
   has already been published, so a mistake in step 4 is corrected by bumping
   step 1 and walking the sequence again — not by overwriting. The bump must
   therefore precede the publish, never follow it.

## Pull requests

- Branch from `main`, keep the change focused, remove callers in the same
  change (no compatibility shims — see `AGENTS.md` cleanup rules).
- Fill in `.github/pull_request_template.md`: what changed, which gates you
  ran, DB-gated skips vs failures, and which docs you updated.
- Every privileged console mutation must end with audit + route-snapshot
  invalidation; every security layer stays fail-closed; telemetry stays
  metadata-only and best-effort. The layer docs (`ARCHITECTURE.md` map)
  explain each invariant where it applies.
