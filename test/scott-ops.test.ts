import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScottOpsTools, scottOpsPath } from "../server/integrations/scott-ops.js";

describe("scottOpsPath", () => {
  it("skips empty values and encodes the rest", () => {
    expect(scottOpsPath("/api/search", { q: "pay rent" })).toBe("/api/search?q=pay+rent");
    expect(scottOpsPath("/api/browse", { kind: "tasks", q: undefined, status: "", limit: 5 })).toBe(
      "/api/browse?kind=tasks&limit=5",
    );
    expect(scottOpsPath("/api/browse", {})).toBe("/api/browse");
  });
});

describe("scott-ops tools", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.SCOTT_OPS_URL = "https://ops.example.test/";
    process.env.SCOTT_OPS_TOKEN = "sot_test";
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SCOTT_OPS_URL;
    delete process.env.SCOTT_OPS_TOKEN;
  });

  const tool = (name: string) => {
    const found = createScottOpsTools().find((t) => t.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  };

  it("exposes the read, write and approval tools", () => {
    expect(createScottOpsTools().map((t) => t.name).sort()).toEqual([
      "scott_ops_browse",
      "scott_ops_capture",
      "scott_ops_get_agenda",
      "scott_ops_resolve_pending",
      "scott_ops_run_action",
      "scott_ops_search",
    ]);
  });

  it("builds strict JSON schemas the Codex runtime can consume", () => {
    const schema = tool("scott_ops_browse").jsonSchema as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["kind"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.kind.enum).toContain("pending");
  });

  it("browse maps arguments onto /api/browse query params", async () => {
    await tool("scott_ops_browse").handle({
      kind: "tasks",
      query: "milk",
      domain_id: "d1",
      limit: 10,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ops.example.test/api/browse?kind=tasks&q=milk&domainId=d1&limit=10");
    expect(init.headers.Authorization).toBe("Bearer sot_test");
  });

  it("resolve_pending posts the decision and re-homing ids", async () => {
    await tool("scott_ops_resolve_pending").handle({
      id: "pc1",
      decision: "accept",
      project_id: "p1",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ops.example.test/api/pending");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ id: "pc1", decision: "accept", projectId: "p1" });
  });

  it("surfaces HTTP failures as tool errors instead of throwing", async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"rate_limited"}', { status: 429 }));
    const result = await tool("scott_ops_search").handle({ query: "rent" });
    expect(JSON.stringify(result)).toContain("rate_limited");
  });
});
