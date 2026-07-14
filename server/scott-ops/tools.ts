import { z } from "zod";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { postCapture } from "./client.js";

const NAMESPACE = "scott_ops";

// Current local date in YYYY-MM-DD for relative due-date resolution
// (Scott Ops resolves due:fri against the client's calendar day, not UTC).
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function capture(text: string, clientDate?: string) {
  try {
    const result = await postCapture(text, clientDate ?? todayIso());
    if (!result.ok) {
      return runtimeText(`[scott_ops] capture failed: ${result.error ?? "unknown error"}`, false);
    }
    const summary = result.summary ?? "Captured.";
    return runtimeText(result.ref ? `${summary} (ref: ${result.ref})` : summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return runtimeText(`[scott_ops] ${msg}`, false);
  }
}

export function createScottOpsTools(namespace = NAMESPACE): RuntimeTool[] {
  return [
    // ── Core freeform capture ─────────────────────────────────────────────────
    defineRuntimeTool(
      namespace,
      "scott_ops_capture",
      `Send a freeform capture string to Scott Ops /api/capture.
Supports all Scott Ops grammar:
  task: <title> [#tag] [due:fri|tomorrow|YYYY-MM-DD] [!high|!low]
  note: <body> [#tag]
  idea: <title>
  quote: "<text>" — Author[, sourcetype]
  journal: <text>
  song: <title> [— Artist] [key A]
  set: add <song> to <service>
No prefix defaults to task:.
Use this tool when you need full control over the capture text or when using
one of the structured helpers below would be redundant.`,
      {
        text: z.string().min(1).describe("The full capture string, exactly as Scott Ops expects it."),
        client_date: z
          .string()
          .optional()
          .describe(
            "Client's local date YYYY-MM-DD for relative due-date resolution (defaults to today on the Boop server).",
          ),
      },
      async ({ text, client_date }) => capture(text, client_date),
    ),

    // ── Structured helpers — compile down to supported capture grammar ────────
    defineRuntimeTool(
      namespace,
      "scott_ops_task",
      `Capture a task in Scott Ops. Compiles to: task: <title> [#tag...] [due:YYYY-MM-DD] [!priority]`,
      {
        title: z.string().min(1).describe("Task title."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Project/domain tags without #, e.g. [\"trm\", \"church\"]."),
        due: z
          .string()
          .optional()
          .describe(
            "Due date: YYYY-MM-DD, or Scott Ops keywords: today, tomorrow, tmr, mon/tue/wed/thu/fri/sat/sun.",
          ),
        priority: z
          .enum(["high", "low"])
          .optional()
          .describe("Task priority. Omit for normal."),
      },
      async ({ title, tags, due, priority }) => {
        const parts: string[] = [`task: ${title}`];
        if (tags?.length) parts.push(tags.map((t) => `#${t}`).join(" "));
        if (due) parts.push(`due:${due}`);
        if (priority) parts.push(`!${priority}`);
        return capture(parts.join(" "));
      },
    ),

    defineRuntimeTool(
      namespace,
      "scott_ops_note",
      `Capture a note in Scott Ops. Compiles to: note: <body> [#tag...]`,
      {
        body: z.string().min(1).describe("Note body."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags without #."),
      },
      async ({ body, tags }) => {
        const parts: string[] = [`note: ${body}`];
        if (tags?.length) parts.push(tags.map((t) => `#${t}`).join(" "));
        return capture(parts.join(" "));
      },
    ),

    defineRuntimeTool(
      namespace,
      "scott_ops_idea",
      `Capture an idea in Scott Ops. Compiles to: idea: <title>`,
      {
        title: z.string().min(1).describe("Idea title or brief description."),
      },
      async ({ title }) => capture(`idea: ${title}`),
    ),

    defineRuntimeTool(
      namespace,
      "scott_ops_quote",
      `Capture a quote in Scott Ops. Compiles to: quote: "<text>" — Author[, sourcetype]
Valid sourceTypes: book, article, podcast, conversation, sermon, other.`,
      {
        text: z.string().min(1).describe("The quoted text."),
        author: z.string().optional().describe("Attribution (person or source name)."),
        source_type: z
          .enum(["book", "article", "podcast", "conversation", "sermon", "other"])
          .optional()
          .describe("Source type — appended after author as 'Author, sourcetype'."),
        tags: z.array(z.string()).optional().describe("Tags without #."),
      },
      async ({ text, author, source_type, tags }) => {
        let capture_text = `quote: "${text}"`;
        if (author) {
          capture_text += ` — ${author}`;
          if (source_type) capture_text += `, ${source_type}`;
        }
        if (tags?.length) capture_text += ` ${tags.map((t) => `#${t}`).join(" ")}`;
        return capture(capture_text);
      },
    ),

    defineRuntimeTool(
      namespace,
      "scott_ops_journal",
      `Capture a journal entry in Scott Ops. Compiles to: journal: <text>`,
      {
        text: z.string().min(1).describe("Journal entry text."),
      },
      async ({ text }) => capture(`journal: ${text}`),
    ),
  ];
}

export function createScottOpsMcp() {
  return createClaudeMcpServer(NAMESPACE, createScottOpsTools(NAMESPACE));
}
