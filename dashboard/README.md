# Dashboard

`dashboard/` is the React/Vite client for the public landing page, the
authenticated `/console` surface, the public `/share/:token` enrollment app, and
the public `/status` model-health page. One `index.html` dispatches by pathname;
share styling remains isolated in `src/share.css` and the status page carries
its own `apps/status/status.css`. Production serves the built files from
`dist/dashboard`.

## Landing

`src/apps/landing/page.tsx` is a static document: every section renders from a
table in that file, with no fetching and no session, so `/` renders for a
signed-out visitor instead of bouncing into the console login. Its styling
lives in `src/apps/landing/landing.css` and `base.css`; `HowItWorks.tsx` keeps
its motion there. `page.test.tsx` pins the section, cell, and readout counts.

The page backdrop is `ConstellationField.tsx`: one `position: fixed` 2D canvas,
first child of `.lr`, behind every content wrapper (`z-index: 0`,
`pointer-events: none`). Stars link to each other and to the pointer when in
range. It loads no 3D dependency — the hero used to mount `OrbitObject`, which
now only serves `Login`, `Setup`, and `Settings`. The neighbour search lives in
`constellation-model.ts` (uniform grid keyed on the link radius) and is unit
tested there; the canvas draws one static frame under reduced motion and stops
while the tab is hidden.

## Route map

`src/main.tsx` dispatches landing, console, share, or status from the pathname. The
console app mounts a `BrowserRouter` with basename `/console` and lazy route
chunks:

| Path | Route component | Backend domain mirror |
| --- | --- | --- |
| `/login`, `/setup`, `/banned` | `Login`, `Setup`, `Banned` | `console/auth` |
| `/` | `Overview` | dashboard summary APIs |
| `/usage` | `Usage` | `console/domains/stats` and usage contracts |
| `/providers` | `Providers` | `console/providers/catalog` |
| `/providers/:providerId` | `ProviderDetail` | `console/providers/detail` and catalog |
| `/providers/:providerId/accounts/test` | `AccountProbeAll` | single-account probe (`accountId` pin) driven client-side at concurrency 4 |
| `/combos` | `Combos` | `console/routing/model` |
| `/quota` | `Quota` | `console/quota` |
| `/automation` | `Automation` | `console/automation/report` |
| `/proxy` | `Proxy` | `network/pool` and routing |
| `/customization` | `Customization` | none (browser-local: `dashboard/src/lib/customization`) |
| `/model-lab` | `Studio` | `console/domains/studio`; the composer's **Generate** tool reuses the `console/generation` panel |
| `/generation` | `Generation` | `console/generation` (image/video tasks and media proxy) |
| `/cli-tools`, `/cli-tools/:toolId` | `CliTools`, `CliToolDetail` | `console/cli-tools` |
| `/console-log` | `ConsoleLog` | `console/domains/logs` and SSE |
| `/settings` | `Settings` | `console/settings` |
| `/prompt-injection` | `PromptInjection` | `console/prompt-injection` |
| `/share` | `Share` | `console/domains/api-keys` and `console/share` |
| `/share/:token` (public root route) | `apps/share/page.tsx` | public child-key enrollment, model cards, and privacy-safe aggregate usage for every child issued by the share template via `src/console/share/share-router.ts` |
| `/status` (public root route) | `apps/status/page.tsx` | model-health timelines from `GET /status/models` (`console/status/`): 60 buckets over 24h, plus each model's cooldown deadline. Scoped to the models a live share key publishes, so the page answers "is the shared access working" rather than exposing the operator's private catalog |

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
