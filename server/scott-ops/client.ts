// HTTP client for Scott Ops /api/capture.
// Auth uses a bearer capture token (sot_...) set via SCOTT_OPS_CAPTURE_TOKEN.

const URL_ENV = "SCOTT_OPS_URL";
const TOKEN_ENV = "SCOTT_OPS_CAPTURE_TOKEN";

export interface ScottOpsConfig {
  url: string;
  token: string;
}

export function getScottOpsConfig(): ScottOpsConfig | null {
  const url = process.env[URL_ENV]?.replace(/\/$/, "");
  const token = process.env[TOKEN_ENV];
  if (!url || !token) return null;
  return { url, token };
}

export interface CaptureResponse {
  ok: boolean;
  summary?: string;
  ref?: string;
  error?: string;
}

export async function postCapture(
  text: string,
  clientDate?: string,
): Promise<CaptureResponse> {
  const config = getScottOpsConfig();
  if (!config) {
    throw new Error(
      `Scott Ops is not configured. Set ${URL_ENV} and ${TOKEN_ENV} in your .env.local.`,
    );
  }

  const body: { text: string; clientDate?: string } = { text };
  if (clientDate) body.clientDate = clientDate;

  const res = await fetch(`${config.url}/api/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as CaptureResponse;

  // Scott Ops always returns { ok, summary } on success or { error } on failure.
  if (!res.ok && data.ok === undefined) {
    return { ok: false, error: data.error ?? `HTTP ${res.status}` };
  }
  return data;
}
