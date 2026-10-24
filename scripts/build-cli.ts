/**
 * Builds the `lianrouter` launcher and the Windows tray host.
 *
 * Two bundles come out of every run, because the CLI spawns the second one as a
 * separate process (`resolveTrayEntry` looks for `dist/tray.js` next to the CLI
 * bundle) and a missing tray entry turns `lianrouter tray` into a silent no-op:
 *
 * - `cli/src/main.ts` → `cli/dist/cli.js` — `bin` in `cli/package.json` points
 *   here, so `bun add -g lianrouter` gets a runnable script without a compile.
 * - `cli/tray/host.ts` → `cli/dist/tray.js` — the tray host process.
 *
 * `--compile` additionally emits `cli/dist/lianrouter-cli[.exe]`, a standalone
 * executable for machines without Bun on PATH. The tray is not compiled: the
 * launcher spawns it with `process.execPath`, which in a compiled install is the
 * launcher executable itself, so the tray entry is loaded by that runtime rather
 * than compiled into a second binary.
 *
 * Minification stays off on purpose: a launcher that dies on a customer's
 * machine is debugged from its stack trace, and a minified one has none.
 *
 * Usage: `bun run scripts/build-cli.ts [--compile]`
 */
import { rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Anchored to this file, not the process cwd.
 *
 * Bun runs lifecycle scripts with cwd set to the package directory, so
 * `cli/package.json`'s `prepublishOnly` invokes this script from `cli/`. Every
 * literal below used to be cwd-relative, which made `npm publish` fail with
 * `ENOENT: failed to open root directory: cli/src` — the one path that must work
 * for the published package. `--outdir` stays caller-relative (an operator
 * passing `out` means `./out`), because that is the only path a human types.
 */
const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(REPO_ROOT, "cli/src/main.ts");
const TRAY_ENTRY = join(REPO_ROOT, "cli/tray/host.ts");
const OUT_DIR = join(REPO_ROOT, "cli/dist");
const BUNDLE_NAME = "cli.js";
const TRAY_BUNDLE_NAME = "tray.js";
const COMPILED_NAME = "lianrouter-cli";

export interface BuildCliOptions {
  /** Emit a standalone executable in addition to the bundles. */
  readonly compile: boolean;
  readonly outdir: string;
  readonly entry: string;
  readonly trayEntry: string;
}

/** What one build produced. `compiled` is absent unless `--compile` was passed. */
export interface BuildCliArtifacts {
  readonly cli: string;
  readonly tray: string;
  readonly compiled?: string;
}

/**
 * Artifact path `bun build --compile` writes for the launcher.
 *
 * Bun appends `.exe` on a Windows target regardless of the host, so the suffix
 * is derived from the build target rather than `process.platform` — otherwise a
 * Linux CI cross-compiling the Windows launcher reports a path that was never
 * written.
 */
export function compiledCliPath(outdir: string, target?: string): string {
  const base = join(outdir, COMPILED_NAME);
  const wantsExe = target === undefined ? process.platform === "win32" : target.startsWith("bun-windows");
  return wantsExe ? `${base}.exe` : base;
}

/** Reads `--compile` and optional `--outdir`/`--target` from argv. */
export function resolveBuildOptions(argv: readonly string[]): BuildCliOptions {
  let compile = false;
  // The default is absolute; an explicit `--outdir` is taken as the caller
  // typed it, relative to the caller's cwd.
  let outdir = OUT_DIR;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--compile") {
      compile = true;
      continue;
    }
    if (arg === "--outdir") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--outdir requires a value");
      }
      outdir = value;
      i += 1;
    }
  }
  return { compile, outdir, entry: ENTRY, trayEntry: TRAY_ENTRY };
}

/**
 * Bundles one entry to one fixed filename.
 *
 * Bun's `naming` template can only derive a name from the entry file, so
 * `cli/src/main.ts` would land as `main.js`. Building each entry separately is
 * what keeps the two published names stable — `bin` and `resolveTrayEntry` both
 * depend on them.
 */
async function bundle(
  entry: string,
  outdir: string,
  name: string,
  buildFn: typeof Bun.build,
  label: string,
): Promise<void> {
  const result = await buildFn({
    entrypoints: [entry],
    outdir,
    root: REPO_ROOT,
    target: "bun",
    format: "esm",
    naming: name,
    minify: false,
    // Both entries read their environment (install root, control file, package
    // version) at runtime, so nothing may be inlined at build time.
    sourcemap: "none",
  });
  if (!result.success) {
    const details = result.logs.map((entry) => String(entry)).join("\n");
    throw new Error(`${label} bundle failed:\n${details}`);
  }
}

export async function buildCli(
  options: BuildCliOptions = resolveBuildOptions([]),
  buildFn: typeof Bun.build = Bun.build,
): Promise<BuildCliArtifacts> {
  // Bun labels each bundled module with its path relative to the process cwd, so
  // the same inputs produce different bytes depending on where the build was
  // started. `prepublishOnly` runs from `cli/`, which made the published bundle
  // differ from a repo-root build for no reason. Pinning the cwd to the repo
  // root makes the two invocations byte-identical; the caller's own cwd is
  // restored before returning so an explicitly relative `--outdir` still means
  // what the operator typed.
  const callerCwd = process.cwd();
  const outdir = isAbsolute(options.outdir) ? options.outdir : resolve(callerCwd, options.outdir);

  process.chdir(REPO_ROOT);
  try {
    await rm(outdir, { recursive: true, force: true });

    await bundle(options.entry, outdir, BUNDLE_NAME, buildFn, "launcher");
    await bundle(options.trayEntry, outdir, TRAY_BUNDLE_NAME, buildFn, "tray");

    const cliBundle = resolve(outdir, BUNDLE_NAME);
    const trayBundle = resolve(outdir, TRAY_BUNDLE_NAME);
    if (!options.compile) {
      return { cli: cliBundle, tray: trayBundle };
    }

    const outfile = compiledCliPath(outdir);
    const compiled = await buildFn({
      entrypoints: [options.entry],
      outdir,
      root: REPO_ROOT,
      target: "bun",
      format: "esm",
      naming: COMPILED_NAME,
      minify: false,
      sourcemap: "none",
      compile: { outfile },
    });
    if (!compiled.success) {
      const details = compiled.logs.map((entry) => String(entry)).join("\n");
      throw new Error(`launcher compile failed:\n${details}`);
    }
    return { cli: cliBundle, tray: trayBundle, compiled: outfile };
  } finally {
    process.chdir(callerCwd);
  }
}

if (import.meta.main) {
  const options = resolveBuildOptions(process.argv.slice(2));
  const artifacts = await buildCli(options);
  console.log(`built ${artifacts.cli}`);
  console.log(`built ${artifacts.tray}`);
  if (artifacts.compiled !== undefined) {
    console.log(`built ${artifacts.compiled}`);
  }
}
