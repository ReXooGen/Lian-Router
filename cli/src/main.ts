#!/usr/bin/env bun
import { run } from "./launcher";

/**
 * Bin entry for the published launcher.
 *
 * All logic lives in `launcher.ts` so it can be imported by tests and by the
 * menu's own module without executing anything; this file only translates the
 * outcome into an exit code.
 */

try {
  const code = await run(process.argv.slice(2));
  // A clean return means every session handle was already disposed by the
  // launcher (the tray handoff stops the control server, supervisor, and
  // embedded cluster before it returns). Setting the exit code and letting
  // the runtime drain avoids the SYNCHRONOUS TERMINATION NOTICE Bun prints
  // when process.exit force-cuts pending exit hooks.
  process.exitCode = code;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`lianrouter: ${message}`);
  process.exit(1);
}
