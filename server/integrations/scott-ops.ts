import { z } from "zod";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { registerIntegration } from "./registry.js";

const NAMESPACE = "scott-ops";

const REQUEST_TIMEOUT_MS = 30_000;

function baseUrl(): string {
  const url = process.env.SCOTT_OPS_URL;
  if (!url) throw new Error("SCOTT_OPS_URL is not set");
  return url.replace(/\/$/, "");
}

function token(): string {
  const value = process.env.SCOTT_OPS_TOKEN;
  if (!value) throw new Error("SCOTT_OPS_TOKEN is not set");
  return value;
}

async function opsRequest(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<string> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${path}: ${text || res.statusText}`);
  }
  return text;
}

// Must match BROWSE_KINDS in Scott-Ops (src/lib/server/browse.ts).
const SCOTT_OPS_BROWSE_KINDS = [
  "tasks",
  "domains",
  "projects",
  "people",
  "companies",
  "notes",
  "quotes",
  "books",
  "ideas",
  "pending",
] as const;

// Builds `path?a=1&b=2`, skipping undefined/empty values.
export function scottOpsPath(
  path: string,
  query: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return runtimeText(`[scott-ops error] ${message}`, false);
}

async function wrap(fn: () => Promise<string>) {
  try {
    return runtimeText(await fn());
  } catch (err) {
    return toolError(err);
  }
}

export function createScottOpsTools(namespace = NAMESPACE): RuntimeTool[] {
  return [
    defineRuntimeTool(
      namespace,
      "scott_ops_capture",
      "Capture free text into the user's personal operations dashboard. Preferred over scott_ops_run_action whenever intent is fuzzy — unknown or ambiguous input queues for the user's review instead of executing. Supports optional prefixes (task:/note:/idea:/quote:/journal:/song:/set:), #domain-or-project tags, due dates (due:fri, due:2026-08-01), and !high priority.",
      {
        text: z
          .string()
          .describe(
            "The text to capture, e.g. 'task: pay insurance #finance due:fri !high'. Plain text with no prefix is fine too.",
          ),
        client_date: z
          .string()
          .optional()
          .describe(
            "Current date/time in the user's timezone (ISO 8601), so relative due dates like due:fri resolve correctly.",
          ),
      },
      async ({ text, client_date }) =>
        wrap(() =>
          opsRequest("/api/capture", {
            method: "POST",
            body: { text, ...(client_date ? { clientDate: client_date } : {}) },
          }),
        ),
    ),
    defineRuntimeTool(
      namespace,
      "scott_ops_get_agenda",
      "Read the user's agenda from their personal operations dashboard: next-7-days events, due and overdue tasks (with task ids for scott_ops_run_action), pending captures, observations, and worship services. The `attention` block has counts (overdue, due today, pending captures) plus what is slipping: stalled projects, overdue follow-ups, and people not contacted in 60+ days — good material for a briefing. Times are ISO 8601 UTC — convert to the user's timezone before summarising.",
      {},
      async () => wrap(() => opsRequest("/api/agenda")),
    ),
    defineRuntimeTool(
      namespace,
      "scott_ops_search",
      "Free-text search across the user's tasks, projects, people, companies, conversations, notes, quotes and books (not the journal). Returns ids, titles and short details. Use when the user asks \"find…\" or mentions something by name; use scott_ops_browse to list a whole category.",
      {
        query: z.string().describe("Text to look for (min 2 characters)."),
      },
      async ({ query }) => wrap(() => opsRequest(scottOpsPath("/api/search", { q: query }))),
    ),
    defineRuntimeTool(
      namespace,
      "scott_ops_browse",
      "List items of one kind from the user's dashboard, with ids you can pass to scott_ops_run_action. kind=domains/projects give the domainId/projectId needed to file a task in the right place. Tasks default to open ones, projects to active ones, pending to captures awaiting review; pass status=\"all\" for everything.",
      {
        kind: z
          .enum(SCOTT_OPS_BROWSE_KINDS)
          .describe("What to list."),
        query: z.string().optional().describe("Only rows containing this text."),
        status: z
          .string()
          .optional()
          .describe('Filter by status (tasks: open/done/cancelled; projects: active/paused/completed/archived) or "all".'),
        domain_id: z.string().optional().describe("Tasks/projects in this domain."),
        project_id: z.string().optional().describe("Tasks in this project."),
        limit: z.number().optional().describe("Max rows (default 50, max 100)."),
      },
      async ({ kind, query, status, domain_id, project_id, limit }) =>
        wrap(() =>
          opsRequest(
            scottOpsPath("/api/browse", {
              kind,
              q: query,
              status,
              domainId: domain_id,
              projectId: project_id,
              limit,
            }),
          ),
        ),
    ),
    defineRuntimeTool(
      namespace,
      "scott_ops_resolve_pending",
      "Settle a pending capture (one that was queued for review, e.g. because it used an unknown #tag). accept runs it — for a task you can re-home it with domain_id/project_id from scott_ops_browse; dismiss discards it. Get ids from scott_ops_browse kind=pending. Confirm with the user before accepting or dismissing unless they already told you what to do.",
      {
        id: z.string().describe("Pending capture id."),
        decision: z.enum(["accept", "dismiss"]),
        domain_id: z.string().optional().describe("Re-home an accepted task to this domain."),
        project_id: z.string().optional().describe("Re-home an accepted task to this project."),
      },
      async ({ id, decision, domain_id, project_id }) =>
        wrap(() =>
          opsRequest("/api/pending", {
            method: "POST",
            body: {
              id,
              decision,
              ...(domain_id ? { domainId: domain_id } : {}),
              ...(project_id ? { projectId: project_id } : {}),
            },
          }),
        ),
    ),
    defineRuntimeTool(
      namespace,
      "scott_ops_run_action",
      'Run a structured action against the user\'s personal operations dashboard. Use only when intent is unambiguous; otherwise prefer scott_ops_capture. Examples: {"type":"create_task","title":"...","domainId":"...","projectId":"...","dueDate":"...","priority":"...","notes":"..."} or {"type":"complete_task","taskId":"..."} (task ids come from scott_ops_get_agenda).',
      {
        action: z
          .record(z.unknown())
          .describe('The action object, including its "type" field.'),
      },
      async ({ action }) =>
        wrap(() => opsRequest("/api/actions", { method: "POST", body: { action } })),
    ),
  ];
}

export function createScottOpsMcp() {
  return createClaudeMcpServer(NAMESPACE, createScottOpsTools(NAMESPACE));
}

export function registerScottOpsIntegration(): void {
  registerIntegration({
    name: NAMESPACE,
    description:
      "The user's personal operations dashboard (Scott-Ops) — system of record for their tasks, projects, agenda, and free-text captures. Rate-limited to 300 requests/hour.",
    requiredEnv: ["SCOTT_OPS_URL", "SCOTT_OPS_TOKEN"],
    isEnabled: async () =>
      Boolean(process.env.SCOTT_OPS_URL && process.env.SCOTT_OPS_TOKEN),
    createServer: async () => createScottOpsMcp(),
    createTools: async () => createScottOpsTools(),
  });
  console.log("[scott-ops] registered personal dashboard integration");
}
