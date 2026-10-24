# Dashboard

`dashboard/` is the React/Vite client for the authenticated `/console` surface
and the public `/share/:token` enrollment app. One `index.html` dispatches by
pathname; share styling remains isolated in `src/share.css`. Production serves
the built files from `dist/dashboard`.

This build is console-only. There is no public marketing page: `/` and
`/index.html` redirect to `/console/`, and `resolveDashboardApp` returns
`console` for every path outside `/share`. The console is the whole product
surface a visitor sees.

## Route map

`src/main.tsx` dispatches console or share from the pathname; the root document
redirects into the console. The
console app mounts a `BrowserRouter` with basename `/console` and lazy route
chunks:

| Path | Route component | Backend domain mirror |
| --- | --- | --- |
| `/login`, `/setup`, `/banned` | `Login`, `Setup`, `Banned` | `console/auth` |
| `/` | `Overview` | dashboard summary APIs |
| `/usage` | `Usage` | `console/domains/stats` and usage contracts |
| `/providers` | `Providers` | `console/providers/catalog` |
| `/providers/:providerId` | `ProviderDetail` | `console/providers/detail` and catalog |
| `/combos` | `Combos` | `console/routing/model` |
| `/quota` | `Quota` | `console/quota` |
| `/proxy` | `Proxy` | `network/pool` and routing |
| `/customization` | `Customization` | none (browser-local: `dashboard/src/lib/customization`) |
| `/model-lab` | `Studio` | `console/domains/studio` |
| `/cli-tools`, `/cli-tools/:toolId` | `CliTools`, `CliToolDetail` | `console/cli-tools` |
| `/console-log` | `ConsoleLog` | `console/domains/logs` and SSE |
| `/settings` | `Settings` | `console/settings` |
| `/prompt-injection` | `PromptInjection` | `console/prompt-injection` |
| `/share` | `Share` | `console/domains/api-keys` and `console/share` |
| `/share/:token` (public root route) | `apps/share/page.tsx` | public child-key enrollment, model cards, and privacy-safe aggregate usage for every child issued by the share template via `src/console/share/share-router.ts` |

Unknown protected paths redirect to `/`. Session transitions clear the shared
query cache and navigate to `/login` or `/banned` rather than rendering stale
tenant data.

## Contracts and parity

- `src/lib/contracts.ts` is the dashboard's API mirror. Backend DTOs remain the
authority; update the mirror in the same change and keep `dashboard/src/*-parity.test.ts`
  checks green.
- Provider display names in `src/lib/provider-names.ts` mirror the canonical
  bundled provider registry. Keep the exact bundled count and ids synchronized;
  BYOK providers are runtime data, not bundled registry entries.
- `src/components/ProviderIcon.tsx`'s `iconAssets` map and `Providers.tsx`'s
  `FREE_LIMITED_IDS` / `FREE_AVAILABLE_IDS` / `FOUNDING_IDS` sets are the same
  kind of hand-copied provider-id list, guarded by
  `src/provider-lists-parity.test.ts`. The icon map may carry extra keys for
  ids a user can type into a compatible-provider form; every bundled id must
  have one.
- `src/lib/contracts.ts` derives the session mirror from the backend
  `SessionStatusResponse` (a discriminated union on `status`) and pins it in
  `src/session-parity.test.ts`, so the wire arm and the dashboard view cannot
  drift field-by-field.
- `src/lib/contracts.ts` re-exports the backend `USAGE_DIMENSIONS` tuple from
  `src/console/domains/stats/usage-periods.ts` (not `stats/contracts.ts`, which
  imports Elysia and would pull `node:crypto` into the browser). The Usage page
  validates `?dim=` against that tuple at runtime. Pinned by
  `src/usage-dimensions-parity.test.ts`.
- Usage periods are generated into `src/lib/generated/usage-periods.json` by
  `bun run codegen`; do not hand-maintain a second period list.
- Query keys, hooks, and route components must use the existing `consoleRequest`
  API boundary instead of constructing another HTTP client or importing backend
  modules.

## Update modal

`src/components/UpdateModal.tsx` is mounted by `DashboardShell` next to the
command palette, so it appears on every console page without a route of its own.
It renders nothing unless the gateway reports an available release.

It reads one endpoint and calls one:

- `GET /console/api/update` → `{ launcher, current, latest, available,
  notesUrl, publishedAt, running, progress }`. `latest`, `notesUrl` and
  `publishedAt` may be `null`; `progress` is `null` or `{ phase, percent,
  message, bytesReceived, bytesTotal, error }` with `percent` in `0..100` and
  the counters and `error` nullable. `launcher: false` means the gateway was not
  started by the `lianrouter` launcher, so the modal only points at
  `lianrouter update` and offers no button.
- `POST /console/api/update/start` → `202 { accepted: true }`, or an
  `ApiErrorShape` with status 409 `update_in_progress`, 503
  `launcher_unavailable`, or 502 `launcher_error`.

`src/lib/hooks/update.ts` owns the query and mutation. The status query polls
every 2s while `running`, otherwise every 60s, and validates the payload with
`assertUpdateStatus` before the modal renders it. The wire types are re-exported
from `src/lib/contracts.ts`, which mirrors `src/console/update/contracts.ts`.

Dismissal is stored per version in `localStorage` under
`lianrouter.update.dismissed`, so a newer release re-opens the modal. During an
install the modal shows the launcher's phase and a determinate bar; an `error`
phase renders the launcher's message with a Retry. Because the launcher restarts
the gateway, the modal then polls `GET /health` (not `/console/api`) every 2s for
up to 90s and reloads the page when the gateway answers. If it never answers,
the modal says so and offers Reload.

## Browser-safe boundary

Vite bundles this tree for browsers. Never import backend modules, Elysia,
`node:*` APIs, database clients, provider adapters, secrets, or server-only
crypto into `dashboard/src`. Keep browser contracts as plain types and values;
hand-copy only the intentionally mirrored display metadata and protect it with
a parity test. OAuth tokens and provider credentials must stay server-side.

`dashboard/tsconfig.json` sets `verbatimModuleSyntax` so an `import type` stays
erased. Without it, TypeScript emits a value import for an `export type` from a
backend module, and Vite then bundles that module's server graph — including
`node:crypto` — into the browser. Do not turn the flag off to make an import
compile; split the type from the value, or hand-copy the browser-safe constant.


For route changes, update the lazy import, protected route map, shell navigation,
API hook, and this table together. For backend contract changes, update the
backend DTO, dashboard mirror, hook/request shape, affected route, and parity
coverage in one change.

## Development and verification

From the repository root, use the dashboard workspace scripts:

```bash
bun run --cwd dashboard dev
bun run dashboard:typecheck
bun run dashboard:test
bun run dashboard:build
```

`dev`, `typecheck`, `test`, and `build` run the usage-period code generator
first. Use `dashboard:build` before live-verifying a backend-served console.
