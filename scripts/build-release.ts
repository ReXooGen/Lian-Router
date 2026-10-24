/**
 * Packages the release archive the updater and the first-run bootstrap consume.
 *
 * The contract is not invented here: `pickAssetForPlatform()` matches
 * `lianrouter-<platform>-<arch>.zip` by exact token, `extractArchive()` unpacks
 * it into a staging directory, and `installAtomically()` replaces exactly the
 * top-level entries it finds there. `ensureGatewayInstalled()` additionally
 * asserts that `<installRoot>/<binary>` exists after the install, so a payload
 * nested one level deep is a hard failure rather than a silent spawn error.
 *
 * That is why the three inputs are staged flat before zipping: the gateway
 * executable, `migrations/`, and `dist/dashboard/` must sit at the archive root,
 * exactly as they sit at the install root.
 *
 * The inputs come from `bun run build`:
 *   - `dist/lianrouter[.exe]`  from `scripts/build-binary.ts`
 *   - `dist/dashboard/`        from `bun run dashboard:build`
 *   - `drizzle/migrations/`    the source of truth; the install root calls it
 *                              `migrations/` because the compiled binary reads
 *                              `<cwd>/migrations` in production mode
 *
 * Usage: `bun run scripts/build-release.ts [--outdir dist/release]`
 *
 * Prints the archive's sha256 and a ready-to-paste release-asset line. GitHub's
 * asset `digest` field must carry `sha256:<hex>`: an asset without a digest is
 * refused by the update engine, so a release published without it cannot be
 * installed by anyone.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/** The gateway's own `dist/` — build output, not the launcher's. */
const REPO_ROOT = resolve(import.meta.dir, "..");
const BINARY_DIR = join(REPO_ROOT, "dist");
const DASHBOARD_SOURCE = join(REPO_ROOT, "dist", "dashboard");
const MIGRATIONS_SOURCE = join(REPO_ROOT, "drizzle", "migrations");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "dist", "release");

/** Directory name the install root uses for the migration ledger. */
const MIGRATIONS_ENTRY = "migrations";
/** Dashboard lives under `dist/` in the install root, mirroring the gateway's layout. */
const DIST_ENTRY = "dist";

/**
 * Platform/arch vocabulary, restricted to what the engine matches.
 *
 * `process.platform` already yields `win32`/`darwin`/`linux`, which is the same
 * spelling `pickAssetForPlatform` compares against, so no translation table is
 * needed — but the value is validated anyway, because an unsupported host would
 * otherwise produce an archive no client would ever select.
 */
const SUPPORTED_PLATFORMS: Record<string, true> = { win32: true, darwin: true, linux: true };
const SUPPORTED_ARCHES: Record<string, true> = { x64: true, arm64: true };

export interface ReleaseCoordinates {
  readonly platform: string;
  readonly arch: string;
}

export interface ReleaseLayout {
  /** Release archive file name, e.g. `lianrouter-win32-x64.zip`. */
  readonly assetName: string;
  /** Gateway executable name at the archive root. */
  readonly binaryName: string;
  /** Top-level archive entries, in the order they are added to the zip. */
  readonly entries: readonly string[];
}

/** Gateway executable name for a platform, matching `resolveBinaryName()`. */
export function releaseBinaryName(platform: string): string {
  return platform === "win32" ? "lianrouter.exe" : "lianrouter";
}

/**
 * Archive name the engine selects for a host.
 *
 * Mirrors the token vocabulary of `pickAssetForPlatform`: platform and arch are
 * lowercase, separated by `-`, and `.zip` is the extension because it is the
 * only format every supported host unpacks without extra tooling.
 */
export function releaseAssetName(coordinates: ReleaseCoordinates): string {
  const platform = coordinates.platform.toLowerCase();
  const arch = coordinates.arch.toLowerCase();
  if (SUPPORTED_PLATFORMS[platform] !== true) {
    throw new Error(
      `no release archive for platform "${coordinates.platform}"; expected one of ${Object.keys(SUPPORTED_PLATFORMS).join(", ")}`,
    );
  }
  if (SUPPORTED_ARCHES[arch] !== true) {
    throw new Error(
      `no release archive for arch "${coordinates.arch}"; expected one of ${Object.keys(SUPPORTED_ARCHES).join(", ")}`,
    );
  }
  return `lianrouter-${platform}-${arch}.zip`;
}

/**
 * Top-level entries of the archive.
 *
 * Flat on purpose: the install step replaces exactly these names inside the
 * install root, and the bootstrap fails when the executable is not one of them.
 */
export function releaseEntries(coordinates: ReleaseCoordinates): readonly string[] {
  return [releaseBinaryName(coordinates.platform), MIGRATIONS_ENTRY, DIST_ENTRY];
}

/** Resolves the full layout for a host. */
export function releaseLayout(coordinates: ReleaseCoordinates): ReleaseLayout {
  return {
    assetName: releaseAssetName(coordinates),
    binaryName: releaseBinaryName(coordinates.platform),
    entries: releaseEntries(coordinates),
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies the build outputs into a flat staging directory.
 *
 * `dist/dashboard` is copied under `<staging>/dist/dashboard` so the archive's
 * top-level `dist` entry is exactly what the install root wants. The caller
 * validates the three sources first, so a missing build never leaves a
 * half-staged tree behind.
 */
async function stagePayload(stagingDir: string, layout: ReleaseLayout): Promise<void> {
  await mkdir(join(stagingDir, DIST_ENTRY), { recursive: true });
  await cp(join(BINARY_DIR, layout.binaryName), join(stagingDir, layout.binaryName));
  await cp(MIGRATIONS_SOURCE, join(stagingDir, MIGRATIONS_ENTRY), { recursive: true });
  await cp(DASHBOARD_SOURCE, join(stagingDir, DIST_ENTRY, "dashboard"), { recursive: true });
}

/** Refuses a missing build input before anything is created or deleted. */
async function assertBuildInputs(layout: ReleaseLayout): Promise<void> {
  const binarySource = join(BINARY_DIR, layout.binaryName);
  if (!(await pathExists(binarySource))) {
    throw new Error(
      `${binarySource} is missing; run \`bun run build\` (or \`bun run build:binary\`) first`,
    );
  }
  if (!(await pathExists(DASHBOARD_SOURCE))) {
    throw new Error(`${DASHBOARD_SOURCE} is missing; run \`bun run dashboard:build\` first`);
  }
  if (!(await pathExists(MIGRATIONS_SOURCE))) {
    throw new Error(`${MIGRATIONS_SOURCE} is missing; it is the migration source of truth`);
  }
}

/**
 * Resolves the zip command for this host.
 *
 * Windows 10+ ships bsdtar, which writes a zip when `-a` is given and the output
 * name ends in `.zip`; a stock Windows image has no `zip` at all. POSIX has
 * `zip` on most systems and bsdtar on macOS, so `zip` is preferred there and
 * `tar -a` is the fallback. A host with neither is refused by name rather than
 * left with a half-written archive.
 */
export function resolveZipCommand(
  platform: string,
  entries: readonly string[],
  archivePath: string,
): readonly string[] {
  const zip = Bun.which("zip");
  const tar = Bun.which("tar");

  if (platform !== "win32" && zip !== null) {
    return [zip, "-r", "-q", archivePath, ...entries];
  }
  if (tar !== null) {
    // `-a` lets bsdtar infer the format from the `.zip` suffix; GNU tar does not
    // understand `-a` with zip and fails loudly, which is the desired outcome.
    return [tar, "-a", "-c", "-f", archivePath, ...entries];
  }
  throw new Error(
    "cannot create a .zip archive: neither `zip` nor `tar` is on PATH. " +
      "Install bsdtar (Windows 10+ ships it) or `zip`, then rerun.",
  );
}

export interface BuildReleaseOptions {
  readonly outDir?: string;
  readonly platform?: string;
  readonly arch?: string;
}

export interface BuildReleaseArtifact {
  readonly archivePath: string;
  readonly assetName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly entries: readonly string[];
}

export async function buildRelease(options: BuildReleaseOptions = {}): Promise<BuildReleaseArtifact> {
  const coordinates: ReleaseCoordinates = {
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
  };
  const layout = releaseLayout(coordinates);
  const outDir = options.outDir === undefined ? DEFAULT_OUT_DIR : resolve(options.outDir);
  const stagingDir = join(outDir, "staging");
  const archivePath = join(outDir, layout.assetName);

  // Before anything is deleted or created: a build with no binary must not
  // remove a previous release from `dist/release` on its way to failing, and a
  // host without a zip tool must fail before a staging directory exists.
  await assertBuildInputs(layout);
  const argv = resolveZipCommand(coordinates.platform, layout.entries, archivePath);

  await rm(stagingDir, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await mkdir(stagingDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  try {
    await stagePayload(stagingDir, layout);

    const child = Bun.spawn([...argv], {
      cwd: stagingDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`zip failed (${basename(argv[0] ?? "zip")} exit ${exitCode}): ${stderr.trim()}`);
    }
    if (!(await pathExists(archivePath))) {
      throw new Error(`zip reported success but ${archivePath} does not exist`);
    }

    const sha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");
    const size = await stat(archivePath);
    return {
      archivePath,
      assetName: layout.assetName,
      sha256,
      bytes: size.size,
      entries: layout.entries,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/** Reads `--outdir <path>` from argv. */
export function resolveOutDir(argv: readonly string[]): string | undefined {
  const flag = argv.indexOf("--outdir");
  if (flag === -1) {
    return undefined;
  }
  const value = argv[flag + 1];
  if (value === undefined || value.length === 0) {
    throw new Error("--outdir requires a path");
  }
  return value;
}

if (import.meta.main) {
  try {
    const outDir = resolveOutDir(process.argv.slice(2));
    const artifact = await buildRelease(outDir === undefined ? {} : { outDir });
    console.log(`[release] ${artifact.archivePath} (${artifact.bytes} bytes)`);
    console.log(`[release] entries: ${artifact.entries.join(", ")}`);
    console.log(`[release] sha256: ${artifact.sha256}`);
    console.log(
      `[release] asset: ${artifact.assetName} sha256:${artifact.sha256} (GitHub's asset digest must match this value)`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[release] ${message}`);
    process.exit(1);
  }
}
