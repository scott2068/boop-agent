import { useEffect, useState } from "react";
import { EmptyState, PanelPage, panelCardClass, mutedTextClass } from "./PanelPrimitives.js";

type Entry = { id: string; at: string; level: string; source: string; message: string };
type LogResult = { entries: Entry[]; total: number; sources: string[]; path: string };
function desktopRequest<T>(type: string, payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", receive); };
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== "boop-log-result" || event.data.id !== id) return;
      cleanup();
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
    };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error("The desktop app did not respond. Please try again.")); }, 5000);
    window.addEventListener("message", receive);
    window.parent.postMessage({ type, id, ...payload }, "*");
  });
}
const format = (entry: Entry) => `${new Date(entry.at).toLocaleString()} [${entry.level.toUpperCase()}] ${entry.source}\n${entry.message}`;

export function LogsPanel({ isDark, inDesktopShell }: { isDark: boolean; inDesktopShell: boolean }) {
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("issues");
  const [source, setSource] = useState("all");
  const [paused, setPaused] = useState(false);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<LogResult | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const muted = mutedTextClass(isDark);
  const control = `rounded-lg border px-3 py-2 text-xs ${isDark ? "border-zinc-700 bg-zinc-900 text-zinc-100" : "border-zinc-300 bg-white text-zinc-900"}`;
  useEffect(() => {
    if (!inDesktopShell) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const data = await desktopRequest<LogResult>("boop-read-logs", { options: { search, level, source, limit: 500 } }); if (!cancelled) { setResult(data); setError(""); } }
      catch (err) { if (!cancelled) setError(String(err)); }
      if (!cancelled && !paused) timer = setTimeout(load, 3000);
    }
    timer = setTimeout(load, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [search, level, source, paused, revision, inDesktopShell]);
  async function copy(text: string) {
    try { await desktopRequest<boolean>("boop-copy-log", { text }); setError(""); setNotice("Copied to clipboard."); }
    catch { setError("Could not copy. Select the log text and copy it manually."); }
  }
  return <PanelPage eyebrow="Diagnostics" title="Logs" description="Errors, warnings and service activity in one place.">
    {!inDesktopShell ? <EmptyState isDark={isDark}>Open Boop Desktop to read the logs saved on this Mac.</EmptyState> : <>
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <label className={`flex flex-col gap-1 text-xs flex-1 min-w-48 ${muted}`}>Search<input className={control} type="search" placeholder="Search messages or sources…" value={search} onChange={e => setSearch(e.target.value)} /></label>
        <label className={`flex flex-col gap-1 text-xs ${muted}`}>Severity<select className={control} value={level} onChange={e => setLevel(e.target.value)}><option value="issues">Errors &amp; warnings</option><option value="all">All activity</option><option value="error">Errors only</option><option value="warning">Warnings only</option><option value="info">Information only</option></select></label>
        <label className={`flex flex-col gap-1 text-xs ${muted}`}>Source<select className={control} value={source} onChange={e => setSource(e.target.value)}><option value="all">All sources</option>{result?.sources.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
        <button className={control} onClick={() => setRevision(r => r + 1)}>Refresh</button>
        <button className={control} aria-pressed={paused} onClick={() => setPaused(p => !p)}>{paused ? "Resume" : "Pause"}</button>
        <button className={control} onClick={() => copy(result?.entries.map(format).join("\n\n") ?? "")}>Copy visible</button>
        <button className={control} onClick={() => window.parent.postMessage({ type: "boop-show-log-folder" }, "*")}>Show log file</button>
      </div>
      <p role="status" className={`text-xs mb-3 ${muted}`}>{result ? `${result.entries.length} of ${result.total} matching entries · ${paused ? "Paused" : "Live"} · Newest first · Local time` : "Loading logs…"} {notice}</p>
      {error && <p role="alert" className="text-sm text-rose-500 mb-3">{error}</p>}
      {result?.entries.length === 0 && <EmptyState isDark={isDark}>No matching log entries.</EmptyState>}
      <div className="space-y-3">{result?.entries.map(entry => <article key={entry.id} className={panelCardClass(isDark, "p-4")}>
        <div className={`flex items-center gap-3 text-xs ${muted}`}><span className={`uppercase font-semibold ${entry.level === "error" ? "text-rose-500" : entry.level === "warning" ? "text-amber-500" : "text-sky-500"}`}>{entry.level}</span><span>{entry.source}</span><time className="ml-auto" dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time><button className={control} aria-label={`Copy ${entry.source} log entry`} onClick={() => copy(format(entry))}>Copy</button></div>
        <pre className={`mt-3 text-xs whitespace-pre-wrap break-words font-mono ${isDark ? "text-zinc-200" : "text-zinc-800"}`}>{entry.message}</pre>
      </article>)}</div>
      <p className={`mt-5 text-xs break-all ${muted}`}>Saved locally across restarts. Up to three 2 MB files are retained. Common credentials and phone numbers are redacted.<br />{result?.path}</p>
    </>}
  </PanelPage>;
}
