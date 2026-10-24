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
  process.exit(code);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`lianrouter: ${message}`);
  process.exit(1);
}
