/**
 * Central client-version sources and resolvers for provider integrations.
 *
 * Every entry follows the same discovered → pinned fallback order.
 * Provider-specific header builders remain next to their integrations, while
 * the network source and resolver state live in this table.
 */
import {
  createClientVersionResolver,
  isSemverish,
  type ClientVersionResolver,
} from "./client-version-resolver";

async function qoderVersion(response: Response): Promise<string | null> {
  try {
    const parsed = (await response.json()) as { version?: unknown };
    return isSemverish(parsed.version) ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

async function clineClientVersion(response: Response): Promise<string | null> {
  const data = (await response.json()) as { version?: unknown };
  return isSemverish(data.version) ? data.version.trim() : null;
}

async function clineSdkVersion(response: Response): Promise<string | null> {
  const data = (await response.json()) as {
    version?: unknown;
    "dist-tags"?: { latest?: unknown };
  };
  const candidate = data.version ?? data["dist-tags"]?.latest;
  return isSemverish(candidate) ? candidate.trim() : null;
}

/**
 * Newest tag from a GitHub `releases.atom` feed.
 *
 * The API's `/releases/latest` costs a rate-limit token and answers 403 once the
 * unauthenticated budget is gone, which on a shared egress IP is routine. The
 * feed is the same data as XML, costs nothing, and is what the release page
 * itself renders. Entries are ordered newest-first, so the first well-formed
 * `vX.Y.Z` tag wins.
 */
async function githubReleaseVersion(response: Response): Promise<string | null> {
  const xml = await response.text();
  const match = /<title>\s*v?(\d+\.\d+\.\d+)\s*<\/title>/.exec(xml);
  return match?.[1] ?? null;
}

async function pypiVersion(response: Response): Promise<string | null> {
  const data = (await response.json()) as { info?: { version?: unknown } };
  return isSemverish(data.info?.version) ? data.info.version.trim() : null;
}

async function workbuddyDesktopVersion(response: Response): Promise<string | null> {
  try {
    const data = (await response.json()) as { version?: unknown; productVersion?: unknown };
    const candidate = data.productVersion ?? data.version;
    return typeof candidate === "string" && /^\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/.test(candidate.trim())
      ? candidate.trim()
      : null;
  } catch {
    return null;
  }
}

/** Ordered upstream sources and pinned fallbacks for every client version. */
export const VERSION_SOURCES = {
  qoder: {
    key: "qoder",
    fallback: "1.1.96",
    sources: [
      {
        url: "https://registry.npmjs.org/@qoder-ai/qodercli/latest",
        extract: qoderVersion,
      },
    ],
  },
  opencode: {
    key: "opencode",
    // The free-tier gate answers `426 UpgradeRequired` for any `user-agent`
    // below 1.18.0, so a registry publishing an older artifact must never be
    // stamped on a dispatch. The pinned fallback is itself above the floor.
    fallback: "1.19.6",
    minVersion: "1.18.0",
    sources: [{ url: "https://registry.npmjs.org/opencode-ai/latest" }],
  },
  commandcode: {
    key: "commandcode",
    fallback: "1.93.2",
    sources: [{ url: "https://registry.npmjs.org/command-code/latest" }],
  },
  grok: {
    key: "grok",
    fallback: "1.0.92",
    sources: [
      { url: "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable" },
      { url: "https://registry.npmjs.org/@xai-official/grok/latest" },
    ],
  },
  clineClient: {
    key: "cline-client",
    fallback: "4.1.27",
    minVersion: "4.1.20",
    sources: [
      {
        url: "https://raw.githubusercontent.com/cline/cline/main/apps/vscode/package.json",
        extract: clineClientVersion,
      },
    ],
  },
  clineSdk: {
    key: "cline-sdk",
    fallback: "0.2.1",
    sources: [{ url: "https://registry.npmjs.org/@cline/sdk/latest", extract: clineSdkVersion }],
  },
  codex: {
    key: "codex",
    fallback: "0.172.0",
    sources: [{ url: "https://registry.npmjs.org/@openai/codex/latest" }],
  },
  // OMP agent (`omp` CLI, oh-my-pi). The CLI's own face is `omp/<version>`, and
  // the client stamps its own release into it — `omp --version` reports 19.x
  // while the npm package `@oh-my-pi/pi-coding-agent` stayed on the 18.x line,
  // so reading npm advertised a client one major version behind every install
  // in the wild. Release tags live on GitHub; the atom feed is read instead of
  // the API because the API costs quota.
  ompAgent: {
    key: "omp-agent",
    fallback: "19.1.1",
    sources: [
      {
        url: "https://github.com/can1357/oh-my-pi/releases.atom",
        extract: githubReleaseVersion,
      },
    ],
  },
  workbuddyClient: {
    key: "workbuddy-client",
    fallback: "5.11.4.44121853",
    sources: [
      {
        url: "https://www.workbuddy.ai/v2/update?platform=workbuddy-win32-x64-user",
        extract: workbuddyDesktopVersion,
      },
      {
        url: "https://www.workbuddy.ai/v2/update?platform=workbuddy-darwin-arm64",
        extract: workbuddyDesktopVersion,
      },
    ],
  },
  workbuddyCli: {
    key: "workbuddy",
    fallback: "2.186.0",
    sources: [
      { url: "https://registry.npmjs.org/@tencent-ai/codebuddy-code/latest" },
      { url: "https://registry.npmmirror.com/@tencent-ai/codebuddy-code/latest" },
    ],
  },
  kimiCli: {
    key: "kimi-cli",
    fallback: "1.52.0",
    sources: [{ url: "https://pypi.org/pypi/kimi-cli/json", extract: pypiVersion }],
  },
  codebuddy: {
    key: "codebuddy",
    fallback: "2.186.0",
    sources: [
      { url: "https://registry.npmjs.org/@tencent-ai/codebuddy-code/latest" },
      { url: "https://registry.npmmirror.com/@tencent-ai/codebuddy-code/latest" },
    ],
  },
  claudeCli: {
    key: "claude-cli",
    // Current `@anthropic-ai/claude-code` release, so the billing
    // `cc_version=` suffix and the `claude-cli/` User-Agent stay on what
    // upstream ships.
    fallback: "2.1.331",
    sources: [{ url: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest" }],
  },
  hermes: {
    key: "hermes-agent",
    // `hermes-agent` on PyPI, published by Nous Research. Hermes stamps its own
    // release into the `hermes-agent/<version>` User-Agent and into the portal
    // tag `client=hermes-client-v<version>`, and it sources both from
    // `hermes_cli.__version__` at runtime — so the number a real install sends
    // moves with every release and a pinned literal here starts lying
    // immediately. PyPI project JSON is the publisher's own record of that
    // string, which makes it the honest discovery source.
    fallback: "0.19.0",
    sources: [{ url: "https://pypi.org/pypi/hermes-agent/json", extract: pypiVersion }],
  },
  claudeSdk: {
    key: "claude-sdk",
    // The `@anthropic-ai/sdk` version *bundled inside the Claude Code
    // release* — the value stamped into the OAuth refresh User-Agent template
    // (`anthropic-sdk-typescript/{claude_code_sdk_version} userOAuthProvider`).
    // npm's standalone SDK is a different release line and is deliberately not
    // discovered: it would advertise a version Claude Code never bundled. Bump
    // alongside the CLI.
    fallback: "0.128.0",
    sources: [],
  },
} as const;

const resolvers = {
  qoder: createClientVersionResolver(VERSION_SOURCES.qoder),
  opencode: createClientVersionResolver(VERSION_SOURCES.opencode),
  commandcode: createClientVersionResolver(VERSION_SOURCES.commandcode),
  grok: createClientVersionResolver(VERSION_SOURCES.grok),
  clineClient: createClientVersionResolver(VERSION_SOURCES.clineClient),
  clineSdk: createClientVersionResolver(VERSION_SOURCES.clineSdk),
  codex: createClientVersionResolver(VERSION_SOURCES.codex),
  ompAgent: createClientVersionResolver(VERSION_SOURCES.ompAgent),
  workbuddyClient: createClientVersionResolver(VERSION_SOURCES.workbuddyClient),
  workbuddyCli: createClientVersionResolver(VERSION_SOURCES.workbuddyCli),
  kimiCli: createClientVersionResolver(VERSION_SOURCES.kimiCli),
  codebuddy: createClientVersionResolver(VERSION_SOURCES.codebuddy),
  claudeCli: createClientVersionResolver(VERSION_SOURCES.claudeCli),
  claudeSdk: createClientVersionResolver(VERSION_SOURCES.claudeSdk),
  hermes: createClientVersionResolver(VERSION_SOURCES.hermes),
} satisfies Record<keyof typeof VERSION_SOURCES, ClientVersionResolver>;

export function getQoderVersion(): string {
  return resolvers.qoder.get();
}

export async function resolveQoderVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.qoder.ensure(fetcher, signal);
  return getQoderVersion();
}

export function _resetQoderVersion(version: string | null = null): void {
  resolvers.qoder.reset(version);
}

export function getOpenCodeVersion(): string {
  return resolvers.opencode.get();
}

export function refreshOpenCodeVersion(fetcher?: typeof fetch): void {
  resolvers.opencode.refresh(fetcher);
}

export async function resolveOpenCodeVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.opencode.ensure(fetcher, signal);
  return getOpenCodeVersion();
}

export function _resetOpenCodeVersion(version: string | null = null): void {
  resolvers.opencode.reset(version);
}

export function getCommandCodeVersion(): string {
  return resolvers.commandcode.get();
}

export async function resolveCommandCodeVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.commandcode.ensure(fetcher, signal);
  return getCommandCodeVersion();
}

export function _resetCommandCodeVersion(version: string | null = null): void {
  resolvers.commandcode.reset(version);
}

export function getGrokVersion(): string {
  return resolvers.grok.get();
}

export async function resolveGrokVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.grok.ensure(fetcher, signal);
  return getGrokVersion();
}

export function refreshGrokVersion(fetcher?: typeof fetch): void {
  resolvers.grok.refresh(fetcher);
}

export function buildGrokUserAgent(version = getGrokVersion()): string {
  return `grok-shell/${version} (linux; x86_64)`;
}

export function buildGrokAuthUserAgent(version = getGrokVersion()): string {
  return `grok-pager/${version} grok-shell/${version} (linux; x86_64)`;
}

export function _resetGrokVersionCache(version: string | null = null): void {
  resolvers.grok.reset(version);
}

export function getClineClientVersion(): string {
  return resolvers.clineClient.get();
}

export function getClineSdkVersion(): string {
  return resolvers.clineSdk.get();
}

export async function resolveClineClientVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.clineClient.ensure(fetcher, signal);
  return getClineClientVersion();
}

export async function resolveClineSdkVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.clineSdk.ensure(fetcher, signal);
  return getClineSdkVersion();
}

export function refreshClineClientVersion(fetcher?: typeof fetch): void {
  resolvers.clineClient.refresh(fetcher);
}

export async function resolveWorkBuddyClientVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.workbuddyClient.ensure(fetcher, signal);
  return getWorkBuddyClientVersion();
}

export function _resetWorkBuddyClientVersionCache(version: string | null = null): void {
  resolvers.workbuddyClient.reset(version);
}

export function getCodexVersion(): string {
  return resolvers.codex.get();
}

export function getHermesVersion(): string {
  return resolvers.hermes.get();
}

export async function resolveHermesVersion(
  fetcher?: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  await resolvers.hermes.ensure(fetcher, signal);
  return getHermesVersion();
}

export function _resetHermesVersion(version: string | null = null): void {
  resolvers.hermes.reset(version);
}

export function getOmpAgentVersion(): string {
  return resolvers.ompAgent.get();
}

export async function resolveOmpAgentVersion(
  fetcher?: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  await resolvers.ompAgent.ensure(fetcher, signal);
  return getOmpAgentVersion();
}

export function _resetOmpAgentVersion(version: string | null = null): void {
  resolvers.ompAgent.reset(version);
}

export async function resolveCodexVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.codex.ensure(fetcher, signal);
  return getCodexVersion();
}

export function refreshCodexVersion(fetcher?: typeof fetch): void {
  resolvers.codex.refresh(fetcher);
}

export function _resetCodexVersion(version: string | null = null): void {
  resolvers.codex.reset(version);
}

export function getWorkBuddyClientVersion(): string {
  return resolvers.workbuddyClient.get();
}

export function getWorkBuddyCliVersion(): string {
  return resolvers.workbuddyCli.get();
}

export async function resolveWorkBuddyVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await Promise.all([
    resolvers.workbuddyClient.ensure(fetcher, signal),
    resolvers.workbuddyCli.ensure(fetcher, signal),
  ]);
  return getWorkBuddyCliVersion();
}

export function buildWorkBuddyUserAgent(
  clientVersion = getWorkBuddyClientVersion(),
  cliVersion = getWorkBuddyCliVersion(),
): string {
  return `WorkBuddy/${clientVersion} WorkBuddy AI/${clientVersion} CLI/${cliVersion}`;
}

export function _resetWorkBuddyVersionCache(version: string | null = null): void {
  resolvers.workbuddyCli.reset(version);
}

export function getKimiCliVersion(): string {
  return resolvers.kimiCli.get();
}

export async function resolveKimiCliVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.kimiCli.ensure(fetcher, signal);
  return getKimiCliVersion();
}

export function refreshKimiCliVersion(fetcher?: typeof fetch): void {
  resolvers.kimiCli.refresh(fetcher);
}

export function _resetKimiCliVersion(version: string | null = null): void {
  resolvers.kimiCli.reset(version);
}

export function getCodeBuddyVersion(): string {
  return resolvers.codebuddy.get();
}

export async function resolveCodeBuddyVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.codebuddy.ensure(fetcher, signal);
  return getCodeBuddyVersion();
}

export function buildCodeBuddyUserAgent(
  identity: "IDE" | "CLI",
  version = getCodeBuddyVersion(),
): string {
  return `${identity}/${version} CodeBuddy/${version}`;
}

export function _resetCodeBuddyVersionCache(version: string | null = null): void {
  resolvers.codebuddy.reset(version);
}

export function getClaudeCliVersion(): string {
  return resolvers.claudeCli.get();
}

export async function resolveClaudeCliVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.claudeCli.ensure(fetcher, signal);
  return getClaudeCliVersion();
}

export function getClaudeSdkVersion(): string {
  return resolvers.claudeSdk.get();
}

export async function resolveClaudeSdkVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.claudeSdk.ensure(fetcher, signal);
  return getClaudeSdkVersion();
}

export function _resetClaudeVersionCache(version: string | null = null): void {
  resolvers.claudeCli.reset(version);
  resolvers.claudeSdk.reset(version);
}

/**
 * Every resolver whose value a User-Agent identity preset advertises.
 *
 * Listed by preset name rather than by resolver key because the keys and the
 * preset vocabulary differ (`ompAgent` vs `omp`), and the route that renders the
 * dropdown labels speaks the preset vocabulary.
 */
const IDENTITY_VERSION_RESOLVERS = [
  ["codex", () => resolvers.codex],
  ["claude-cli", () => resolvers.claudeCli],
  ["hermes-agent", () => resolvers.hermes],
  ["omp", () => resolvers.ompAgent],
] as const;

/**
 * Fills the discovery cache for every identity preset, in parallel.
 *
 * Called once at boot, before the listener accepts traffic. Not awaited by the
 * request path and never throws: discovery is best-effort and the pinned
 * fallback is a working answer, so a registry outage or a network-less deploy
 * must not delay or fail the boot.
 *
 * The resolvers re-check once per TTL window after this, so a client shipping a
 * new release is picked up without a restart.
 */
export async function warmIdentityVersions(fetcher: typeof fetch = globalThis.fetch): Promise<void> {
  await Promise.allSettled(
    IDENTITY_VERSION_RESOLVERS.map(([, resolver]) => resolver().ensure(fetcher)),
  );
}

/** How often the background refresh re-reads every resolver. */
const IDENTITY_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Keeps the identity-version cache warm for the lifetime of the process.
 *
 * Without this the cache only moves when a dispatch happens to await a resolver
 * — and the User-Agent presets resolve synchronously, so on a gateway whose
 * custom providers sit idle the advertised version would stay at whatever the
 * boot warm found until the next restart. An hourly-ish timer is the difference
 * between "tracks the client it claims to be" and "tracks it once per deploy".
 *
 * `unref` so a pending refresh never holds the process open during shutdown.
 * Returns a stop function for tests and for an orderly teardown.
 */
export function startIdentityVersionRefresh(
  intervalMs: number = IDENTITY_REFRESH_INTERVAL_MS,
  fetcher: typeof fetch = globalThis.fetch,
): () => void {
  const timer = setInterval(() => {
    void warmIdentityVersions(fetcher).catch(() => {});
  }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return () => clearInterval(timer);
}
