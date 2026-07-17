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
      "Read the user's agenda from their personal operations dashboard: next-7-days events, due and overdue tasks (with task ids for scott_ops_run_action), pending captures, observations, and worship services. Times are ISO 8601 UTC — convert to the user's timezone before summarising.",
      {},
      async () => wrap(() => opsRequest("/api/agenda")),
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
      "The user's personal operations dashboard (Scott-Ops) — system of record for their tasks, projects, agenda, and free-text captures. Rate-limited to 60 requests/hour.",
    requiredEnv: ["SCOTT_OPS_URL", "SCOTT_OPS_TOKEN"],
    isEnabled: async () =>
      Boolean(process.env.SCOTT_OPS_URL && process.env.SCOTT_OPS_TOKEN),
    createServer: async () => createScottOpsMcp(),
    createTools: async () => createScottOpsTools(),
  });
  console.log("[scott-ops] registered personal dashboard integration");
}
