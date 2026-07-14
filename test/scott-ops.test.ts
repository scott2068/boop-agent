import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getScottOpsConfig, postCapture } from "../server/scott-ops/client.js";
import { createScottOpsTools } from "../server/scott-ops/tools.js";

const ORIG_URL = process.env.SCOTT_OPS_URL;
const ORIG_TOKEN = process.env.SCOTT_OPS_CAPTURE_TOKEN;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("scott-ops client", () => {
  beforeEach(() => {
    process.env.SCOTT_OPS_URL = "https://ops.example.com";
    process.env.SCOTT_OPS_CAPTURE_TOKEN = "sot_test_token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIG_URL === undefined) delete process.env.SCOTT_OPS_URL;
    else process.env.SCOTT_OPS_URL = ORIG_URL;
    if (ORIG_TOKEN === undefined) delete process.env.SCOTT_OPS_CAPTURE_TOKEN;
    else process.env.SCOTT_OPS_CAPTURE_TOKEN = ORIG_TOKEN;
  });

  it("returns null config when env vars are missing", () => {
    delete process.env.SCOTT_OPS_URL;
    expect(getScottOpsConfig()).toBeNull();

    process.env.SCOTT_OPS_URL = "https://ops.example.com";
    delete process.env.SCOTT_OPS_CAPTURE_TOKEN;
    expect(getScottOpsConfig()).toBeNull();
  });

  it("returns config when both vars are set", () => {
    const config = getScottOpsConfig();
    expect(config).toEqual({
      url: "https://ops.example.com",
      token: "sot_test_token",
    });
  });

  it("strips trailing slash from SCOTT_OPS_URL", () => {
    process.env.SCOTT_OPS_URL = "https://ops.example.com/";
    expect(getScottOpsConfig()?.url).toBe("https://ops.example.com");
  });

  it("throws when env vars are absent", async () => {
    delete process.env.SCOTT_OPS_URL;
    await expect(postCapture("task: test")).rejects.toThrow("not configured");
  });

  it("posts to /api/capture with bearer auth and returns ok response", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, summary: "Captured." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await postCapture("task: buy groceries", "2026-07-14");

    expect(result).toEqual({ ok: true, summary: "Captured." });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ops.example.com/api/capture");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer sot_test_token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      text: "task: buy groceries",
      clientDate: "2026-07-14",
    });
  });

  it("returns error shape on non-ok HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "unauthorized" })),
    );

    const result = await postCapture("task: test");
    expect(result).toEqual({ ok: false, error: "unauthorized" });
  });

  it("omits clientDate from body when not provided (tools supply it)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, summary: "Captured." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await postCapture("note: quick thought");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // clientDate is injected by tools (todayIso); raw postCapture without it
    // should not include the key in the body.
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("clientDate");
  });
});

describe("scott-ops tools", () => {
  beforeEach(() => {
    process.env.SCOTT_OPS_URL = "https://ops.example.com";
    process.env.SCOTT_OPS_CAPTURE_TOKEN = "sot_test_token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIG_URL === undefined) delete process.env.SCOTT_OPS_URL;
    else process.env.SCOTT_OPS_URL = ORIG_URL;
    if (ORIG_TOKEN === undefined) delete process.env.SCOTT_OPS_CAPTURE_TOKEN;
    else process.env.SCOTT_OPS_CAPTURE_TOKEN = ORIG_TOKEN;
  });

  function tool(name: string) {
    const t = createScottOpsTools().find((t) => t.name === name);
    if (!t) throw new Error(`Tool ${name} not found`);
    return t;
  }

  it("scott_ops_capture posts raw text and returns summary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { ok: true, summary: "Task added." })),
    );

    const result = await tool("scott_ops_capture").handle({
      text: "task: fix login bug #trm due:fri",
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe("Task added.");
  });

  it("scott_ops_capture includes ref when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          ok: true,
          summary: "Queued for review — unknown tag #xyz",
          ref: "pending_abc123",
        }),
      ),
    );

    const result = await tool("scott_ops_capture").handle({ text: "task: test #xyz" });
    expect(result.text).toContain("ref: pending_abc123");
  });

  it("scott_ops_capture surfaces capture error as failed result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "unauthorized" })),
    );

    const result = await tool("scott_ops_capture").handle({ text: "task: test" });
    expect(result.success).toBe(false);
    expect(result.text).toContain("unauthorized");
  });

  it("scott_ops_task compiles task grammar with all options", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, summary: "Task added." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await tool("scott_ops_task").handle({
      title: "fix login bug",
      tags: ["trm", "church"],
      due: "fri",
      priority: "high",
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { text: string };
    expect(body.text).toBe("task: fix login bug #trm #church due:fri !high");
  });

  it("scott_ops_task works with title only", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, summary: "Task added." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await tool("scott_ops_task").handle({ title: "buy milk" });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { text: string };
    expect(body.text).toBe("task: buy milk");
  });

  it("scott_ops_note compiles note grammar", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, summary: "Note added." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await tool("scott_ops_note").handle({ body: "idea about caching", tags: ["dev"] });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { text: string };
    expect(body.text).toBe("note: idea about caching #dev");
  });

  it("scott_ops_idea compiles idea grammar", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, summary: "Idea captured." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await tool("scott_ops_idea").handle({ title: "offline mode for Recap" });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { text: string };
    expect(body.text).toBe("idea: offline mode for Recap");
  });

  it("scott_ops_quote compiles quote grammar with author and source_type", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, summary: "Quote saved." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await tool("scott_ops_quote").handle({
      text: "Faith is confidence",
      author: "Hebrews 11:1",
      source_type: "book",
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { text: string };
    expect(body.text).toBe(`quote: "Faith is confidence" — Hebrews 11:1, book`);
  });

  it("scott_ops_quote works with text only", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, summary: "Quote saved." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await tool("scott_ops_quote").handle({ text: "Be still and know" });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { text: string };
    expect(body.text).toBe(`quote: "Be still and know"`);
  });

  it("scott_ops_journal compiles journal grammar", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, summary: "Journal entry added." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await tool("scott_ops_journal").handle({ text: "today was productive and focused" });

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { text: string };
    expect(body.text).toBe("journal: today was productive and focused");
  });
});
