import { redactPhoneNumbers } from "./privacy.js";

const API_BASE = "https://api.sendblue.com/api";
const FAILED = new Set(["ERROR", "DECLINED", "FAILED"]);
const DELIVERED = new Set(["DELIVERED", "READ"]);
const POLL_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2_000;

type MessageStatus = {
  status?: string;
  message_handle?: string;
  error_code?: number | string | null;
  error_message?: string | null;
  error_reason?: string | null;
  error_detail?: string | null;
};

async function readStatus(response: Response): Promise<MessageStatus> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sendblue HTTP ${response.status}: ${redactPhoneNumbers(body).slice(0, 500)}`);
  }
  const raw = await response.json() as Omit<MessageStatus, "status"> & { status?: string | MessageStatus };
  // The live status endpoint wraps the status record inside `status`, while
  // send-message returns the record directly.
  const message: MessageStatus = raw.status && typeof raw.status === "object"
    ? { ...raw, ...raw.status, status: raw.status.status }
    : raw as MessageStatus;
  if (FAILED.has(message.status ?? "") || message.error_code) {
    const reason = message.error_message || message.error_detail || message.error_reason || `error ${message.error_code ?? message.status}`;
    throw new Error(`Sendblue delivery failed: ${redactPhoneNumbers(reason)}`);
  }
  return message;
}

export async function readSendblueMessageStatus(headers: Record<string, string>, handle: string): Promise<MessageStatus> {
  return readStatus(await fetch(`${API_BASE}/status?handle=${encodeURIComponent(handle)}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  }));
}

// Submit exactly once. Polling only reads status: a timeout is not permission
// to resend, because the original message may still arrive later.
//
// SENT means the carrier accepted the message. SMS (non-iMessage) recipients
// often never advance past it, so it counts as success once the poll window
// ends; only a message still QUEUED (or unknown) is reported as unconfirmed.
// `poll: false` skips polling for non-critical sends that must not block a turn.
export async function deliverSendblueMessage(
  headers: Record<string, string>,
  body: { number: string; content: string; from_number: string },
  options: { poll?: boolean } = {},
): Promise<void> {
  let message = await readStatus(await fetch(`${API_BASE}/send-message`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }));
  if (DELIVERED.has(message.status ?? "") || options.poll === false) return;
  const handle = message.message_handle;
  if (!handle) throw new Error("Sendblue delivery unconfirmed: response omitted the message handle. Do not resend automatically.");

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    message = await readSendblueMessageStatus(headers, handle);
    if (DELIVERED.has(message.status ?? "")) return;
  }
  if (message.status === "SENT") return;
  throw new Error(`Sendblue delivery unconfirmed (status: ${message.status ?? "unknown"}). The message may still arrive; do not resend automatically.`);
}
