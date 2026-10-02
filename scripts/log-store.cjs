const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { format } = require("node:util");

const directory = process.env.BOOP_LOG_DIR || (process.platform === "darwin"
  ? path.join(os.homedir(), "Library", "Logs", "Boop")
  : path.join(os.homedir(), ".boop", "logs"));
const logPath = path.join(directory, "app.jsonl");
const MAX_BYTES = 2 * 1024 * 1024;
let secrets = [];

function configureSecrets(env) {
  secrets = [...new Set([...secrets, ...Object.entries(env)
    .filter(([key, value]) => /key|secret|token|password|credential/i.test(key) && typeof value === "string" && value.length >= 6)
    .map(([, value]) => value)])];
}
configureSecrets(process.env);

function redact(value) {
  let text = String(value).replace(/\x1b\[[0-9;]*m/g, "");
  for (const secret of secrets) text = text.split(secret).join("[redacted]");
  return text
    .replace(/(Bearer\s+)[\w.+/=-]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|secret|token|password|authorization)[\w-]*["']?\s*[:=]\s*["']?)[^\s,"'}&]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s]+/g, (url) => url.replace(/\/\/[^/@\s]+:[^/@\s]+@/, "//[redacted]@").replace(/[?#].*$/, "?[redacted]"))
    .replace(/\+\d[\d ()-]{8,}\d/g, "[phone hidden]")
    .slice(0, 8000);
}

function append(level, source, message) {
  const entry = { id: randomUUID(), at: new Date().toISOString(), level, source: redact(source).slice(0, 80), message: redact(message) };
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(logPath) && fs.statSync(logPath).size >= MAX_BYTES) {
      if (fs.existsSync(logPath + ".2")) fs.unlinkSync(logPath + ".2");
      if (fs.existsSync(logPath + ".1")) fs.renameSync(logPath + ".1", logPath + ".2");
      fs.renameSync(logPath, logPath + ".1");
    }
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch (error) {
    // Never recurse through console or crash the application if the disk is full.
    process.stderr.write(`[boop-log] Log write failed: ${redact(error.message)}\n`);
  }
  return entry;
}

function read(options = {}) {
  const limit = Math.min(1000, Math.max(1, Number(options.limit) || 500));
  const search = String(options.search || "").toLowerCase().slice(0, 200);
  const rows = [];
  for (const suffix of [".2", ".1", ""]) {
    try {
      for (const line of fs.readFileSync(logPath + suffix, "utf8").split("\n")) {
        try { const row = JSON.parse(line); if (row.id && row.at && row.message) rows.push(row); } catch { /* incomplete trailing line */ }
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const sources = [...new Set(rows.map(row => row.source))].sort();
  const filtered = rows.filter(row =>
    (!options.level || options.level === "all" || row.level === options.level || (options.level === "issues" && row.level !== "info")) &&
    (!options.source || options.source === "all" || row.source === options.source) &&
    (!search || `${row.message} ${row.source}`.toLowerCase().includes(search)));
  return { entries: filtered.reverse().slice(0, limit), total: filtered.length, sources, path: logPath };
}

function captureLine(source, line) {
  if (line.includes("[boop-log]")) return;
  const level = /\b(error|fatal|failed|exception|panic|crash|unhandled)\b/i.test(line) ? "error"
    : /\b(warn(?:ing)?|deprecated|deprecation|degraded)\b/i.test(line) ? "warning" : null;
  if (level) append(level, source, line);
}

function installConsoleCapture(source) {
  for (const [method, level] of [["warn", "warning"], ["error", "error"]]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      const message = format(...args);
      const tag = message.match(/^\[([\w-]+)\]/)?.[1];
      append(level, tag || source, message);
      original("[boop-log]", ...args);
    };
  }
  process.on("uncaughtExceptionMonitor", error => append("error", source, error.stack || error.message));
}

module.exports = { append, read, captureLine, installConsoleCapture, configureSecrets, redact, logPath };
