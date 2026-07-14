import { getScottOpsConfig } from "../scott-ops/client.js";
import { createScottOpsMcp, createScottOpsTools } from "../scott-ops/tools.js";
import { registerIntegration } from "./registry.js";

export function registerScottOpsIntegration(): void {
  registerIntegration({
    name: "scott_ops",
    description:
      "Personal ops capture: log tasks, notes, ideas, quotes, and journal entries to Scott Ops via /api/capture. Supports task:, note:, idea:, quote:, journal:, song:, set: prefixes, #tags, due:date, and !priority.",
    isEnabled: async () => Boolean(getScottOpsConfig()),
    createServer: async () => createScottOpsMcp(),
    createTools: async () => createScottOpsTools(),
  });
  console.log("[scott_ops] registered Scott Ops capture integration");
}
