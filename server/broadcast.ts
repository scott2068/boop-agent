import type { WebSocket } from "ws";
import { appLog } from "./app-log.js";

type Client = WebSocket;
const clients = new Set<Client>();

export function addClient(ws: Client): void {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
}

export function broadcast(event: string, data: unknown): void {
  const details = data as { error?: string; status?: string; agentId?: string; runId?: string; automationId?: string } | null;
  if (/failed|error/.test(event) || details?.status === "failed") {
    appLog.append("error", event.split("_")[0], [event, details?.automationId, details?.runId, details?.agentId, details?.error].filter(Boolean).join(" · "));
  }
  const payload = JSON.stringify({ event, data, at: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}
