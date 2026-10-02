import { createRequire } from "node:module";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const log = require("../scripts/log-store.cjs");

describe("central application log", () => {
  it("redacts credentials and persists searchable, filterable entries", () => {
    log.configureSecrets({ SECRET_TOKEN: "sensitive-test-credential" });
    log.append("error", "delivery", "Request failed: sensitive-test-credential Bearer another-secret https://example.com/callback?token=hidden +15551234567");
    log.append("warning", "convex", "Database disconnected");
    log.append("info", "desktop", "Started");
    const result = log.read({ level: "error", source: "delivery", search: "request" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].message).not.toContain("sensitive-test-credential");
    expect(result.entries[0].message).not.toContain("another-secret");
    expect(result.entries[0].message).not.toContain("+15551234567");
    expect(result.entries[0].message).not.toContain("token=hidden");
    expect(log.read({ level: "issues" }).entries.every((e: {level: string}) => e.level !== "info")).toBe(true);
    expect(statSync(log.logPath).mode & 0o777).toBe(0o600);
  });

  it("ignores partial lines and preserves logs across module reloads", () => {
    appendFileSync(log.logPath, '{"unfinished":\n');
    delete require.cache[require.resolve("../scripts/log-store.cjs")];
    const reloaded = require("../scripts/log-store.cjs");
    expect(reloaded.read({ search: "Database disconnected" }).entries).toHaveLength(1);
  });

  it("rotates bounded files while keeping recent history", () => {
    const old = readFileSync(log.logPath, "utf8");
    writeFileSync(log.logPath, old + " ".repeat(2 * 1024 * 1024));
    log.append("error", "server", "New failure after rotation");
    expect(statSync(log.logPath).size).toBeLessThan(10000);
    expect(log.read({ search: "New failure" }).entries).toHaveLength(1);
    expect(log.read({ search: "Database disconnected" }).entries).toHaveLength(1);
  });

  it("does not duplicate already captured runtime errors", () => {
    const before = log.read({}).total;
    log.captureLine("server", "[boop-log] Error already captured");
    expect(log.read({}).total).toBe(before);
    log.captureLine("ngrok", "connection failed");
    expect(log.read({ source: "ngrok" }).entries[0].level).toBe("error");
  });
});
