// Set a dummy CONVEX_URL so convex-client.ts does not throw at module
// initialization when tests run outside a real Convex deployment.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
const logDirectory = mkdtempSync(join(tmpdir(), "boop-test-logs-"));
process.env.BOOP_LOG_DIR = logDirectory;
afterAll(() => rmSync(logDirectory, { recursive: true, force: true }));
// Tests that exercise Convex queries/mutations should mock the client directly.
if (!process.env.CONVEX_URL) {
  process.env.CONVEX_URL = "https://test.convex.cloud";
}
