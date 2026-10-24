/**
 * Release discovery for the self-update engine.
 *
 * The source is the GitHub releases API for this repository's origin. Two
 * choices are deliberate:
 *
 * 1. **The endpoint is overridable through one env var read here, not through
 *    `src/config.ts`.** `src/config.ts` is the gateway's deployment surface and
 *    its keys are mirrored into `.env.example` under the drift test in
 *    `test/config-env-drift.test.ts`; that test walks `src/` only
 *    (`walkTsFiles(SRC_DIR)`), so a CLI-only knob does not belong there. Keeping
 *    the read local also means a compiled CLI binary never drags the gateway
 *    config module — and its database and provider graph — into its bundle.
 *
 * 2. **Checksums come from the release asset digest, not from a sidecar file.**
 *    A sidecar `checksums.txt` would be fetched over the same channel as the
 *    artifact, so an attacker who can swap the artifact can swap the sidecar
 *    too; it proves nothing beyond transport integrity. The API's `digest`
 *    field is served by the same host as the metadata the version decision is
 *    already based on, so it is no weaker and needs no second request. When the
 *    field is absent the asset carries no checksum, and the installer's
 *    mandatory verification step refuses it rather than installing unverified
 *    bytes.
 */
import { compareVersions } from "./contracts";
import type { RawRelease, ReleaseAsset, UpdateChannel, UpdateSource } from "./contracts";

/** Repository origin, as configured in `.git/config` for this checkout. */
export const UPDATE_REPO = "ReXooGen/Lian-Router";

const DEFAULT_RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases`;

/**
 * CLI-only override for the release feed. Read once at module load so the value
 * is stable for the process; a mid-run change would make the version check and
 * the download disagree about which host is authoritative.
 */
const RELEASES_URL = (() => {
  const override = process.env.LIANROUTER_UPDATE_BASE_URL;
  return override !== undefined && override.trim().length > 0
    ? override.trim().replace(/\/+$/, "")
    : DEFAULT_RELEASES_URL;
})();

/** Timeout for the metadata request. A hung check must not stall the console. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A check that could not be answered — rate limiting, network failure, or a
 * non-JSON body. Distinct from "no newer release", which is a successful check
 * with `available: false`: conflating them would tell the user they are current
 * when the truth is that nobody asked.
 */
export class UpdateCheckUnavailableError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "UpdateCheckUnavailableError";
    this.status = status;
  }
}

interface GitHubAssetJson {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size: number;
  readonly digest?: string;
}

interface GitHubReleaseJson {
  readonly tag_name: string;
  readonly html_url: string;
  readonly published_at: string;
  readonly prerelease: boolean;
  readonly draft: boolean;
  readonly assets: readonly GitHubAssetJson[];
}

/**
 * Picks the asset built for a platform/arch pair.
 *
 * Asset names follow `lianrouter-<platform>-<arch>.<ext>`. Matching is by exact
 * token rather than substring so `win32` never matches a hypothetical
 * `lianrouter-darwin-arm64.zip` through an arch coincidence, and `x64` never
 * matches inside `arm64` (which is why the arch token is compared, not searched).
 * `.zip` is preferred over other archives because it is the only format every
 * supported host can unpack without extra tooling. Returns `undefined` when the
 * release ships nothing for this host — the caller reports that as "no build for
 * your platform" instead of downloading a binary that cannot run.
 */
export function pickAssetForPlatform(
  assets: readonly ReleaseAsset[],
  platform: string,
  arch: string,
): ReleaseAsset | undefined {
  const platformToken = platform.toLowerCase();
  const archToken = arch.toLowerCase();

  const scored = assets
    .map((asset) => {
      const stem = asset.name.toLowerCase().replace(/\.[^.]+$/, "");
      const tokens = stem.split(/[-_.]/);
      if (!tokens.includes(platformToken) || !tokens.includes(archToken)) {
        return undefined;
      }
      // Zip first; anything else is a fallback the extractor may not support.
      const rank = asset.name.toLowerCase().endsWith(".zip") ? 0 : 1;
      return { asset, rank };
    })
    .filter((entry): entry is { asset: ReleaseAsset; rank: number } => entry !== undefined)
    .sort((left, right) => left.rank - right.rank);

  return scored[0]?.asset;
}

/** Extracts the bare hex digest from GitHub's `sha256:<hex>` asset digest. */
function digestToChecksum(digest: string | undefined): string | undefined {
  if (digest === undefined) {
    return undefined;
  }
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return match?.[1];
}

/**
 * Shape assumed of one raw API asset. Every field stays `unknown` so the
 * `typeof` checks below are what actually establish the contract — the cast
 * only lets the compiler read the properties we are about to test.
 */
interface RawAssetFields {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
  readonly size?: unknown;
  readonly digest?: unknown;
}

function parseAsset(value: unknown): GitHubAssetJson | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { name, browser_download_url: url, size, digest } = value as RawAssetFields;
  if (typeof name !== "string" || typeof url !== "string" || typeof size !== "number") {
    return undefined;
  }
  return {
    name,
    browser_download_url: url,
    size,
    ...(typeof digest === "string" ? { digest } : {}),
  };
}

/**
 * Shape assumed of one raw API release. Same reasoning as `RawAssetFields`:
 * the `typeof` tests are the contract, the cast just unlocks property reads.
 */
interface RawReleaseFields {
  readonly tag_name?: unknown;
  readonly html_url?: unknown;
  readonly published_at?: unknown;
  readonly prerelease?: unknown;
  readonly draft?: unknown;
  readonly assets?: unknown;
}

/**
 * Narrows one API release object. Drafts are dropped: they are unpublished and
 * their assets are not guaranteed to be downloadable, so offering one would
 * produce a check that succeeds and an update that 404s.
 */
function parseRelease(value: unknown): GitHubReleaseJson | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { tag_name: tag, html_url: url, published_at: published, prerelease, draft, assets } =
    value as RawReleaseFields;
  if (typeof tag !== "string" || typeof url !== "string" || draft === true) {
    return undefined;
  }
  const parsedAssets: GitHubAssetJson[] = [];
  if (Array.isArray(assets)) {
    for (const entry of assets) {
      const asset = parseAsset(entry);
      if (asset !== undefined) {
        parsedAssets.push(asset);
      }
    }
  }
  return {
    tag_name: tag,
    html_url: url,
    published_at: typeof published === "string" ? published : "",
    prerelease: prerelease === true,
    draft: false,
    assets: parsedAssets,
  };
}

/**
 * Fetches releases from the GitHub API and returns the newest one that the
 * channel allows. `beta` accepts prereleases, `stable` does not — a stable
 * channel that offered a beta tag would move users onto untested builds by
 * default, which is the one thing a channel is supposed to prevent.
 */
export class GitHubReleaseSource implements UpdateSource {
  readonly #userAgent: string;

  constructor(currentVersion: string) {
    // GitHub rejects requests without a User-Agent, and identifying the client
    // version makes a bad release report traceable to the build that asked.
    this.#userAgent = `lianrouter-cli/${currentVersion}`;
  }

  async fetchLatest(channel: UpdateChannel): Promise<RawRelease | null> {
    let response: Response;
    try {
      response = await fetch(RELEASES_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": this.#userAgent,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new UpdateCheckUnavailableError(`release feed unreachable: ${reason}`);
    }

    if (response.status === 403 || response.status === 429) {
      // Unauthenticated GitHub allows 60 requests/hour per address. Reporting
      // this as a rate limit (rather than a generic failure) is what lets the
      // console say "update check unavailable" and keep working.
      throw new UpdateCheckUnavailableError(
        "release feed rate limited; try again later",
        response.status,
      );
    }
    if (!response.ok) {
      throw new UpdateCheckUnavailableError(
        `release feed returned ${response.status}`,
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new UpdateCheckUnavailableError("release feed returned a non-JSON body", response.status);
    }
    if (!Array.isArray(payload)) {
      throw new UpdateCheckUnavailableError("release feed returned an unexpected shape");
    }

    const releases = payload
      .map(parseRelease)
      .filter((release): release is GitHubReleaseJson => release !== undefined)
      .filter((release) => channel === "beta" || !release.prerelease);

    let newest: GitHubReleaseJson | undefined;
    for (const release of releases) {
      if (newest === undefined || compareVersions(release.tag_name, newest.tag_name) > 0) {
        newest = release;
      }
    }
    if (newest === undefined) {
      return null;
    }

    const assets: ReleaseAsset[] = newest.assets.map((asset) => {
      const checksum = digestToChecksum(asset.digest);
      return {
        name: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
        ...(checksum === undefined ? {} : { checksum }),
      };
    });

    return {
      version: newest.tag_name,
      notesUrl: newest.html_url,
      ...(newest.published_at.length > 0 ? { publishedAt: newest.published_at } : {}),
      assets,
    };
  }
}
