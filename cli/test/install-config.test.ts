import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertGatewayConfigured,
  describeMissingConfig,
  parseEnvFile,
  resolveGatewayConfig,
  writeStarterConfig,
} from "../src/install-config";
import { resolveConfigFile } from "../src/paths";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lianrouter-config-test-"));
  tempDirs.push(dir);
  return dir;
}

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

describe("parseEnvFile", () => {
  it("keeps a value containing a hash, strips quotes, and skips comments", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        "DATABASE_URL=postgres://user:p#ss@localhost:5432/db",
        'LIANROUTER_ENCRYPTION_KEY="abc"',
        "MALFORMED",
        "1INVALID=x",
        "",
      ].join("\n"),
    );
    expect(parsed["DATABASE_URL"]).toBe("postgres://user:p#ss@localhost:5432/db");
    expect(parsed["LIANROUTER_ENCRYPTION_KEY"]).toBe("abc");
    expect("MALFORMED" in parsed).toBe(false);
    expect("1INVALID" in parsed).toBe(false);
  });
});

describe("resolveGatewayConfig precedence", () => {
  it("lets a shell value beat the file value and injects only the rest", async () => {
    const root = await tempRoot();
    await writeFile(
      resolveConfigFile(root),
      `DATABASE_URL=postgres://file@localhost:5432/file\nLIANROUTER_ENCRYPTION_KEY=${VALID_KEY}\nREDIS_URL=redis://file:6379\n`,
      "utf8",
    );

    const config = resolveGatewayConfig(root, {
      DATABASE_URL: "postgres://shell@localhost:5432/shell",
    });

    // The shell value must never appear in the injected env: the supervisor's
    // `Object.assign` would otherwise overwrite the operator's export.
    expect("DATABASE_URL" in config.env).toBe(false);
    expect(config.env["LIANROUTER_ENCRYPTION_KEY"]).toBe(VALID_KEY);
    expect(config.missing).toEqual([]);
  });

  it("reports both required names when the file is absent", async () => {
    const root = await tempRoot();
    const config = resolveGatewayConfig(root, {});
    expect(config.present).toBe(false);
    expect(config.missing).toEqual(["DATABASE_URL", "LIANROUTER_ENCRYPTION_KEY", "REDIS_URL"]);
  });

  it("does not require REDIS_URL when single_instance_local is set", async () => {
    const root = await tempRoot();
    await writeFile(
      resolveConfigFile(root),
      `DATABASE_URL=postgres://u:p@localhost:5432/db\nLIANROUTER_ENCRYPTION_KEY=${VALID_KEY}\nREDIS_MODE=single_instance_local\n`,
      "utf8",
    );
    expect(resolveGatewayConfig(root, {}).missing).toEqual([]);
  });

  it("requires REDIS_URL in the default mode", async () => {
    const root = await tempRoot();
    await writeFile(
      resolveConfigFile(root),
      `DATABASE_URL=postgres://u:p@localhost:5432/db\nLIANROUTER_ENCRYPTION_KEY=${VALID_KEY}\n`,
      "utf8",
    );
    expect(resolveGatewayConfig(root, {}).missing).toEqual(["REDIS_URL"]);
  });

  it("treats a blank shell value as unset so the file still applies", async () => {
    const root = await tempRoot();
    await writeFile(resolveConfigFile(root), `DATABASE_URL=postgres://file@host:5432/db\n`, "utf8");
    const config = resolveGatewayConfig(root, { DATABASE_URL: "   " });
    expect(config.env["DATABASE_URL"]).toBe("postgres://file@host:5432/db");
  });
});

describe("missing-config failure", () => {
  it("names the file path and both variables", async () => {
    const root = await tempRoot();
    const config = resolveGatewayConfig(root, {});
    expect(() => assertGatewayConfigured(config)).toThrow();

    const message = describeMissingConfig(config);
    expect(message).toContain(resolveConfigFile(root));
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("LIANROUTER_ENCRYPTION_KEY");
    expect(message).toContain("REDIS_URL");
    expect(message).toContain("lianrouter init");
  });

  it("says nothing when both values resolve", async () => {
    const root = await tempRoot();
    await writeFile(
      resolveConfigFile(root),
      `DATABASE_URL=postgres://u:p@localhost:5432/db\nLIANROUTER_ENCRYPTION_KEY=${VALID_KEY}\nREDIS_URL=redis://localhost:6379\n`,
      "utf8",
    );
    expect(() => assertGatewayConfigured(resolveGatewayConfig(root, {}))).not.toThrow();
  });
});

describe("writeStarterConfig", () => {
  it("writes a key that decodes to exactly 32 bytes", async () => {
    const root = await tempRoot();
    const path = writeStarterConfig(root);
    expect(path).toBe(resolveConfigFile(root));

    const text = await readFile(path, "utf8");
    const parsed = parseEnvFile(text);
    const key = parsed["LIANROUTER_ENCRYPTION_KEY"];
    expect(key).toBeDefined();
    if (key === undefined) return;

    // Decode, do not measure the string: base64 and hex have different lengths
    // for the same 32 bytes, and only the decoded size is what the gateway
    // accepts.
    const decoded = /^[0-9a-fA-F]{64}$/.test(key)
      ? Buffer.from(key, "hex")
      : Buffer.from(key, "base64");
    expect(decoded.length).toBe(32);

    // The database line must stay a comment: no invented connection string.
    expect(text).toContain("# DATABASE_URL=");
    expect(parsed["DATABASE_URL"]).toBeUndefined();
  });

  it("refuses to overwrite an existing config file", async () => {
    const root = await tempRoot();
    const path = writeStarterConfig(root);
    const original = await readFile(path, "utf8");

    expect(() => writeStarterConfig(root)).toThrow(/refusing to overwrite/);
    expect(await readFile(path, "utf8")).toBe(original);
  });
});
