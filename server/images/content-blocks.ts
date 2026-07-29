import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { MAX_IMAGE_BYTES, validateImageHeader } from "./mime.js";

export interface ImageBytes {
  bytes: Buffer;
  mediaType: string;
}

export type FetchBytes = (storageId: string) => Promise<ImageBytes>;

export interface BuildPromptArgs {
  text: string;
  imageStorageIds: string[] | undefined;
  fetchBytes: FetchBytes;
  // Codex's app-server protocol has no PDF/document input type (see
  // runtimes/codex-app-server.ts). Passing the runtime here lets PDF
  // attachments fail early with an actionable message instead of a deep,
  // generic error from inside the Codex-specific mapper.
  runtime?: "claude" | "codex";
}

type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
type DocumentBlock = {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
};
type TextBlock = { type: "text"; text: string };

export type PromptInput = string | Array<ImageBlock | DocumentBlock | TextBlock>;

export interface PromptBuildResult {
  prompt: PromptInput;
  imageStorageIds: string[];
  imageError?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function textOnlyImageFallback(text: string): string {
  return `[user sent images, but Boop couldn't retrieve the stored image bytes. Continue using the text-only message; if image details are necessary, say the image could not be inspected.]\n${text}`;
}

export class PdfUnsupportedOnCodexError extends Error {
  constructor() {
    super("PDF attachments aren't supported on the Codex runtime — switch to Claude for this request (e.g. \"use claude\") and resend.");
    this.name = "PdfUnsupportedOnCodexError";
  }
}

function pdfOnCodexFallback(text: string): string {
  return `[user sent a PDF attachment, but the current runtime (Codex) can't read PDFs — only Claude can. Tell the user to switch runtimes (e.g. "use claude") and resend the PDF. Do not say you couldn't retrieve the file; the file is fine, it's a runtime limitation.]\n${text}`;
}

export async function readCappedImageBytes(res: Response): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("stored image fetch returned no body");

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`stored image too large: >${MAX_IMAGE_BYTES} bytes`);
    }
    chunks.push(value);
  }

  const bytes = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function buildPromptWithImages(
  args: BuildPromptArgs,
): Promise<PromptInput> {
  const ids = args.imageStorageIds ?? [];
  if (ids.length === 0) return args.text;

  const fetched = await Promise.all(ids.map((id) => args.fetchBytes(id)));
  if (args.runtime === "codex" && fetched.some((f) => f.mediaType === "application/pdf")) {
    throw new PdfUnsupportedOnCodexError();
  }
  const blocks: Array<ImageBlock | DocumentBlock | TextBlock> = fetched.map(
    ({ bytes, mediaType }) =>
      mediaType === "application/pdf"
        ? {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") },
          }
        : {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
          },
  );
  blocks.push({ type: "text", text: args.text.length > 0 ? args.text : "(attachment)" });
  return blocks;
}

export async function buildPromptWithImagesOrTextFallback(
  args: BuildPromptArgs,
): Promise<PromptBuildResult> {
  const ids = args.imageStorageIds ?? [];
  if (ids.length === 0) return { prompt: args.text, imageStorageIds: [] };

  try {
    return {
      prompt: await buildPromptWithImages(args),
      imageStorageIds: ids,
    };
  } catch (err) {
    const isPdfOnCodex = err instanceof PdfUnsupportedOnCodexError;
    return {
      prompt: isPdfOnCodex ? pdfOnCodexFallback(args.text) : textOnlyImageFallback(args.text),
      imageStorageIds: [],
      imageError: errorMessage(err),
    };
  }
}

export async function fetchStoredBytes(storageId: string): Promise<ImageBytes> {
  // TODO(codegen): drop the `as never` once the regenerated Convex API
  // reflects the new getStorageUrl query (blocked on schema push).
  const url = await convex.query(api.messages.getStorageUrl, {
    storageId: storageId as never,
  });
  if (!url) throw new Error(`image storage missing: ${storageId}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  // Defence-in-depth: a regression in the ingest validator or a future schema
  // change could leave an oversized or wrong-MIME blob behind; refuse rather
  // than balloon memory or poison the Anthropic call.
  const lenHeader = res.headers.get("content-length");
  const check = validateImageHeader({
    contentType: res.headers.get("content-type") ?? undefined,
    contentLength: lenHeader ? Number(lenHeader) : undefined,
  });
  if (!check.ok) throw new Error(`stored image rejected: ${check.reason}`);
  const bytes = await readCappedImageBytes(res);
  return { bytes, mediaType: check.mediaType };
}
