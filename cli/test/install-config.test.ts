import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertGatewayConfigured,
  describeMissingConfig,
  parseEnvFile,
  resolveGatewayConfig,
  writeStarterConfig,
} from "../src/install-config";
import { DEFAULT_CONSOLE_PASSWORD } from "../../src/console/auth/default-console-password";
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

  it("reports every missing name when the file is absent", async () => {
    const root = await tempRoot();
    const config = resolveGatewayConfig(root, {});
    expect(config.present).toBe(false);
    // `DATABASE_MODE` defaults to `url`, so an absent file asks for the URL the
    // gateway requires. `embedded` removes that requirement, and its own test
    // below covers that branch.
    // Order follows the requirement order in `resolveGatewayConfig`, which is
    // not the contract this test exists to pin; the set of names is.
    expect([...config.missing].sort()).toEqual([
      "DATABASE_URL",
      "LIANROUTER_ENCRYPTION_KEY",
      "REDIS_URL",
    ].sort());
  });

  it("does not require DATABASE_URL when DATABASE_MODE=embedded", async () => {
    const root = await tempRoot();
    await writeFile(
      resolveConfigFile(root),
      `DATABASE_MODE=embedded\nLIANROUTER_ENCRYPTION_KEY=${VALID_KEY}\nREDIS_MODE=embedded\n`,
      "utf8",
    );
    const config = resolveGatewayConfig(root, {});
    expect(config.databaseMode).toBe("embedded");
    expect(config.missing).toEqual([]);
  });

  it("still requires DATABASE_URL when DATABASE_MODE is anything else", async () => {
    const root = await tempRoot();
    await writeFile(
      resolveConfigFile(root),
      `DATABASE_MODE=url\nLIANROUTER_ENCRYPTION_KEY=${VALID_KEY}\nREDIS_MODE=embedded\n`,
      "utf8",
    );
    const config = resolveGatewayConfig(root, {});
    expect(config.databaseMode).toBe("url");
    expect(config.missing).toEqual(["DATABASE_URL"]);
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
    const result = writeStarterConfig(root);
    expect(result.kind).toBe("created");
    expect(result.path).toBe(resolveConfigFile(root));

    const text = await readFile(result.path, "utf8");
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

  it("leaves a config that already starts byte-identical", async () => {
    const root = await tempRoot();
    const first = writeStarterConfig(root);
    const original = await readFile(first.path, "utf8");

    const second = writeStarterConfig(root);
    expect(second.kind).toBe("unchanged");
    expect(await readFile(second.path, "utf8")).toBe(original);
  });

  it("makes a file from an older launcher startable", async () => {
    // The exact shape an older release wrote: a commented placeholder for the
    // connection string and `REDIS_MODE=normal` with no server behind it. This
    // file cannot boot, and re-running `init` used to refuse to touch it.
    const root = await tempRoot();
    const path = resolveConfigFile(root);
    const legacy = [
      "# LianRouter gateway configuration.",
      "",
      "# Database. Required.",
      "# DATABASE_URL=postgres://user:password@localhost:5432/lianrouter",
      "",
      `LIANROUTER_ENCRYPTION_KEY=${VALID_KEY}`,
      "",
      "REDIS_MODE=normal",
      "# REDIS_URL=redis://localhost:6379",
      "",
    ].join("\n");
    await writeFile(path, legacy, "utf8");

    const result = writeStarterConfig(root);
    expect(result.kind).toBe("migrated");

    const text = await readFile(path, "utf8");
    const parsed = parseEnvFile(text);
    expect(parsed["DATABASE_MODE"]).toBe("embedded");
    expect(parsed["REDIS_MODE"]).toBe("embedded");
    // The operator's key must survive: a new one cannot decrypt stored secrets.
    expect(parsed["LIANROUTER_ENCRYPTION_KEY"]).toBe(VALID_KEY);
    // And the result must actually pass the check that blocked the gateway.
    expect(() => assertGatewayConfigured(resolveGatewayConfig(root, {}))).not.toThrow();
  });

  it("keeps an operator's own connection string and never adds embedded mode", async () => {
    const root = await tempRoot();
    const path = resolveConfigFile(root);
    await writeFile(
      path,
      `DATABASE_URL=postgres://real@db:5432/mine\nLIANROUTER_ENCRYPTION_KEY=${VALID_KEY}\nREDIS_URL=redis://real:6379\n`,
      "utf8",
    );

    const result = writeStarterConfig(root);
    const parsed = parseEnvFile(await readFile(path, "utf8"));
    expect(result.kind).toBe("migrated");
    expect(parsed["DATABASE_MODE"]).toBeUndefined();
    expect(parsed["REDIS_MODE"]).toBeUndefined();
    expect(parsed["DATABASE_URL"]).toBe("postgres://real@db:5432/mine");
    // The gate line is the one addition a fully-configured file still gets: a
    // local install without it renders a username form nobody asked for.
    expect(parsed["LIANROUTER_CONSOLE_PASSWORD"]).toBe(DEFAULT_CONSOLE_PASSWORD);
  });

  it("leaves an existing console password untouched", async () => {
    const root = await tempRoot();
    const path = resolveConfigFile(root);
    await writeFile(
      path,
      `LIANROUTER_CONSOLE_PASSWORD=operator-secret\nLIANROUTER_ENCRYPTION_KEY=${VALID_KEY}\nDATABASE_MODE=embedded\nREDIS_MODE=embedded\n`,
      "utf8",
    );

    const result = writeStarterConfig(root);
    expect(result.kind).toBe("unchanged");
    const parsed = parseEnvFile(await readFile(path, "utf8"));
    expect(parsed["LIANROUTER_CONSOLE_PASSWORD"]).toBe("operator-secret");
  });

  it("fills in a missing encryption key and leaves a backup of the old file", async () => {
    const root = await tempRoot();
    const path = resolveConfigFile(root);
    await writeFile(path, "REDIS_MODE=normal\n", "utf8");

    const result = writeStarterConfig(root);
    expect(result.kind).toBe("migrated");
    const parsed = parseEnvFile(await readFile(path, "utf8"));
    expect(parsed["LIANROUTER_ENCRYPTION_KEY"]).toBeDefined();

    const backups = (await readdir(root)).filter((name) => name.startsWith(".env.bak-"));
    expect(backups.length).toBe(1);
    expect(await readFile(`${root}/${backups[0]}`, "utf8")).toBe("REDIS_MODE=normal\n");
  });
});
