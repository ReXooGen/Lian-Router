import pkg from "../../package.json";

/**
 * Single Source of Truth for LianRouter versioning and release metadata.
 * All runtime endpoints, observability stores, and metadata helpers import from here.
 */
export const LIANROUTER_VERSION = pkg.version;
