import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

/**
 * `GitHubReleaseSource` reads its endpoint once at module load, so an override
 * can only be exercised in a fresh process. Each case therefore runs a child
 * `bun` process against a local server, which is also the honest test: the
 * production path is a real `fetch` against a real HTTP response, not a stub.
 *
 * The child uses `await import()` because static import cannot work here: the
 * whole point is a process whose module graph has not been evaluated yet.
 */
const MODULE_URL = new URL("../update/github-source.ts", import.meta.url).href;

const servers: { stop: (force?: boolean) => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

interface ChildResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly errorName?: string;
  readonly errorMessage?: string;
  readonly errorStatus?: number;
}

/**
 * Runs one `fetchLatest` call in a child process against `baseUrl` and returns
 * its structured outcome. The child imports the module by absolute URL so its
 * module-level env read sees the override we pass.
 */
async function callSource(baseUrl: string, channel: string): Promise<ChildResult> {
  const script = `
    const mod = await import(${JSON.stringify(MODULE_URL)});
    const source = new mod.GitHubReleaseSource("2.0.0");
    try {
      const release = await source.fetchLatest(${JSON.stringify(channel)});
      console.log(JSON.stringify({ ok: true, value: release }));
    } catch (error) {
      console.log(JSON.stringify({
        ok: false,
        errorName: error.name,
        errorMessage: error.message,
        errorStatus: error.status,
      }));
    }
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, LIANROUTER_UPDATE_BASE_URL: baseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`child failed (${code}): ${stderr}`);
  }
  return JSON.parse(stdout.trim()) as ChildResult;
}

/** Reads `version` off the child's JSON without assuming the whole shape. */
function readVersion(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("version" in value)) {
    return undefined;
  }
  return typeof value.version === "string" ? value.version : undefined;
}

function serveJson(payload: unknown, status = 200): string {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/releases`;
}

const STABLE = {
  tag_name: "v2.5.0",
  html_url: "https://example.invalid/releases/2.5.0",
  published_at: "2026-02-01T00:00:00Z",
  prerelease: false,
  draft: false,
  assets: [
    {
      name: "lianrouter-win32-x64.zip",
      browser_download_url: "https://example.invalid/win.zip",
      size: 4096,
      digest: `sha256:${"b".repeat(64)}`,
    },
  ],
};

const PRERELEASE = {
  tag_name: "v3.0.0-beta.1",
  html_url: "https://example.invalid/releases/3.0.0-beta.1",
  published_at: "2026-03-01T00:00:00Z",
  prerelease: true,
  draft: false,
  assets: [],
};

const DRAFT = {
  tag_name: "v9.0.0",
  html_url: "https://example.invalid/releases/9.0.0",
  published_at: "2026-04-01T00:00:00Z",
  prerelease: false,
  draft: true,
  assets: [],
};

describe("GitHubReleaseSource", () => {
  it("maps a release with its notes, timestamp, and asset digest", async () => {
    const result = await callSource(serveJson([STABLE]), "stable");

    expect(result.ok).toBe(true);
    // Compared as a whole object: this pins the mapping (notes URL, timestamp,
    // digest stripped of its `sha256:` prefix) rather than one field of it.
    expect(result.value).toEqual({
      version: "v2.5.0",
      notesUrl: "https://example.invalid/releases/2.5.0",
      publishedAt: "2026-02-01T00:00:00Z",
      assets: [
        {
          name: "lianrouter-win32-x64.zip",
          url: "https://example.invalid/win.zip",
          size: 4096,
          checksum: "b".repeat(64),
        },
      ],
    });
  });

  it("excludes prereleases from the stable channel but includes them on beta", async () => {
    const url = serveJson([STABLE, PRERELEASE]);

    const stable = await callSource(url, "stable");
    expect(readVersion(stable.value)).toBe("v2.5.0");

    const beta = await callSource(url, "beta");
    expect(readVersion(beta.value)).toBe("v3.0.0-beta.1");
  });

  it("picks the newest release regardless of feed order", async () => {
    const older = { ...STABLE, tag_name: "v2.4.0", html_url: "https://example.invalid/r/2.4.0" };
    const result = await callSource(serveJson([STABLE, older]), "stable");
    expect(readVersion(result.value)).toBe("v2.5.0");
  });

  it("ignores drafts", async () => {
    const result = await callSource(serveJson([DRAFT, STABLE]), "stable");
    expect(readVersion(result.value)).toBe("v2.5.0");
  });

  it("returns null when the channel has no releases", async () => {
    const result = await callSource(serveJson([]), "stable");
    expect(result.ok).toBe(true);
    expect(result.value).toBeNull();
  });

  it("returns null when only prereleases exist and the channel is stable", async () => {
    const result = await callSource(serveJson([PRERELEASE]), "stable");
    expect(result.value).toBeNull();
  });

  it("raises a typed error carrying the status on a rate-limited 403", async () => {
    const result = await callSource(serveJson({ message: "API rate limit exceeded" }, 403), "stable");

    expect(result.ok).toBe(false);
    expect(result.errorName).toBe("UpdateCheckUnavailableError");
    expect(result.errorStatus).toBe(403);
    expect(result.errorMessage).toContain("rate limited");
  });

  it("raises a typed error on a 500", async () => {
    const result = await callSource(serveJson({ message: "boom" }, 500), "stable");
    expect(result.errorName).toBe("UpdateCheckUnavailableError");
    expect(result.errorStatus).toBe(500);
  });

  it("raises a typed error when the body is not JSON", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("<html>not json</html>", { headers: { "content-type": "text/html" } });
      },
    });
    servers.push(server);

    const result = await callSource(`http://127.0.0.1:${server.port}/releases`, "stable");
    expect(result.errorName).toBe("UpdateCheckUnavailableError");
    expect(result.errorMessage).toContain("non-JSON");
  });

  it("raises a typed error when the feed is unreachable", async () => {
    // Port 1 on loopback refuses immediately; no external network is involved.
    const result = await callSource("http://127.0.0.1:1/releases", "stable");
    expect(result.errorName).toBe("UpdateCheckUnavailableError");
    expect(result.errorMessage).toContain("unreachable");
  });
});

describe("module layout", () => {
  it("imports nothing from the gateway config module", async () => {
    // A CLI binary must not pull the gateway's config graph (database, providers)
    // into its bundle; the update endpoint is a CLI-local env read by design.
    // Checked against the import statements rather than the whole file, so the
    // explanatory comment above can keep naming the module it deliberately avoids.
    const source = await Bun.file(join(import.meta.dir, "..", "update", "github-source.ts")).text();
    const importSpecifiers = [...source.matchAll(/^import\b[^;]*?from\s+["']([^"']+)["']/gm)].map(
      (match) => match[1],
    );
    // Every specifier must be relative and local to the CLI; anything reaching
    // into `src/` would drag the gateway graph into the CLI bundle.
    expect(importSpecifiers.length).toBeGreaterThan(0);
    expect(importSpecifiers.every((specifier) => specifier !== undefined && specifier.startsWith("."))).toBe(true);
    expect(importSpecifiers.filter((specifier) => specifier?.includes("src/"))).toEqual([]);
  });
});
