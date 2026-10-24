import pkg from "../package.json";

/**
 * The launcher's own version, read from the published package manifest.
 *
 * The manifest is the only place the number is written: the menu header, the
 * update comparison, and `--version` all read it from here, so a release bump
 * cannot leave the launcher advertising a version it does not have.
 */
export const CLI_VERSION: string = pkg.version;
