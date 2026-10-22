/**
 * Compiles the standalone gateway binary from the AOT build output.
 *
 * Two things here are load-bearing and neither is obvious:
 *
 * 1. **The entry is `dist/main.js`, not `src/main.ts`.** `build-aot.ts` runs
 *    Elysia's AOT plugin, which rewrites TypeBox imports into statically wired
 *    mirrors in its output. Bundling the raw source instead discards that work,
 *    and Elysia's CommonJS build reaches TypeBox through a lazy
 *    `require("typebox/type")` that the bundler cannot follow — the compiled
 *    binary then dies at startup with `Cannot find module 'typebox/type'`,
 *    because a standalone executable has no node_modules to resolve against.
 *
 * 2. **`NODE_ENV` is set to `production` here, at build time, because Bun bakes
 *    it into the binary.** `bun build --compile` replaces `process.env.NODE_ENV`
 *    with a literal, so the value present when this runs is the value the
 *    binary reports forever after — a runtime `NODE_ENV=production` cannot
 *    change it. That matters beyond log formatting: `resolveMigrationsFolder()`
 *    picks `<cwd>/migrations` only when `NODE_ENV === "production"`, and the
 *    development path it otherwise takes is resolved relative to
 *    `import.meta.dir`, which inside a standalone executable is Bun's virtual
 *    `/~BUN` root and can never contain the migrations. A binary built without
 *    this line therefore fails to boot with `Migrations folder not found`.
 *
 * Usage: `bun run scripts/build-binary.ts [--outfile dist/lianrouter]`
 */
const DEFAULT_OUTFILE = "dist/lianrouter";

/**
 * The artifact path `bun build --compile` actually writes for `outfile`.
 *
 * Bun appends `.exe` when it compiles for Windows, so the extensionless
 * `dist/lianrouter` handed to it never exists on that platform. The extension
 * follows the *compile target*, not the host: cross-compiling a Linux binary
 * from Windows writes no `.exe`, and cross-compiling a Windows binary from
 * Linux writes one. Deriving it from `process.platform` was correct only while
 * every build targeted its own host, and reported a missing artifact the first
 * time it did not.
 *
 * This is the one place that knows where the compiled binary lands;
 * `ops-start-binary.ts` resolves its target from here instead of re-deriving
 * the name, because a launcher that probed the requested path reported
 * "run bun run build first" immediately after a successful build.
 */
export function compiledBinaryPath(
  outfile: string = DEFAULT_OUTFILE,
  target?: CompileTarget,
): string {
  const wantsWindowsExe = target === undefined
    ? process.platform === "win32"
    : target.startsWith("bun-windows-");
  return wantsWindowsExe && !outfile.toLowerCase().endsWith(".exe")
    ? `${outfile}.exe`
    : outfile;
}

/** Reads `--outfile <path>`, falling back to a positional path or the default. */
export function resolveOutfile(argv: readonly string[]): string {
  const flag = argv.indexOf("--outfile");
  if (flag !== -1) {
    const value = argv[flag + 1];
    if (value === undefined || value.length === 0) {
      throw new Error("--outfile requires a path");
    }
    return value;
  }
  return argv.find((arg) => arg.length > 0 && !arg.startsWith("-")) ?? DEFAULT_OUTFILE;
}

/**
 * Cross-compilation targets Bun accepts for `compile.target`.
 *
 * Without one, `bun build --compile` emits a binary for the *host* platform,
 * which is how a Windows build once reached a Linux server and failed there.
 * Naming the target makes the deploy artifact's platform a build input rather
 * than an accident of where the build ran.
 */
export type CompileTarget =
  | "bun-linux-x64"
  | "bun-linux-arm64"
  | "bun-linux-x64-musl"
  | "bun-linux-arm64-musl"
  | "bun-windows-x64"
  | "bun-windows-arm64"
  | "bun-darwin-x64"
  | "bun-darwin-arm64";

const COMPILE_TARGETS: Record<CompileTarget, true> = {
  "bun-linux-x64": true,
  "bun-linux-arm64": true,
  "bun-linux-x64-musl": true,
  "bun-linux-arm64-musl": true,
  "bun-windows-x64": true,
  "bun-windows-arm64": true,
  "bun-darwin-x64": true,
  "bun-darwin-arm64": true,
};

/** Reads `--target <bun-os-arch>`, or `undefined` to build for the host. */
export function resolveTarget(argv: readonly string[]): CompileTarget | undefined {
  const flag = argv.indexOf("--target");
  if (flag === -1) return undefined;
  const value = argv[flag + 1];
  if (value === undefined || value.length === 0) {
    throw new Error("--target requires a value");
  }
  if (!Object.hasOwn(COMPILE_TARGETS, value)) {
    throw new Error(
      `--target must be one of ${Object.keys(COMPILE_TARGETS).join(", ")} (got "${value}")`,
    );
  }
  return value as CompileTarget;
}

export async function buildBinary(
  outfile: string = DEFAULT_OUTFILE,
  buildFn: typeof Bun.build = Bun.build,
  target?: CompileTarget,
): Promise<void> {
  // Baked into the output; see the note above before changing it. Substituted
  // through `define` rather than by assigning `process.env`, because this module
  // is imported by tests in the same process — mutating the environment would
  // flip `NODE_ENV` for every later suite in that process.
  const result = await buildFn({
    entrypoints: ["dist/main.js"],
    minify: true,
    target: "bun",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    compile: { outfile, ...(target === undefined ? {} : { target }) },
  });

  if (result.logs.length > 0) {
    for (const log of result.logs) console.error(`[binary] ${log.message}`);
    throw new Error(`binary build emitted ${result.logs.length} diagnostic(s)`);
  }
  console.log(`[binary] compiled ${compiledBinaryPath(outfile, target)}`);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  await buildBinary(resolveOutfile(argv), Bun.build, resolveTarget(argv)).catch(
    (error: unknown) => {
      console.error("[binary] build failed:", error);
      process.exit(1);
    },
  );
}
