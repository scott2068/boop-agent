import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), spawn: vi.fn(), send: vi.fn(), broadcast: vi.fn() }));
vi.mock("../server/convex-client.js", () => ({ convex: { query: mocks.query, mutation: mocks.mutation } }));
vi.mock("../server/execution-agent.js", () => ({ spawnExecutionAgent: mocks.spawn }));
vi.mock("../server/sendblue.js", () => ({ sendImessage: mocks.send }));
vi.mock("../server/broadcast.js", () => ({ broadcast: mocks.broadcast }));
import { runAutomationNow, tickAutomations } from "../server/automations.js";

afterEach(() => vi.resetAllMocks());

it("keeps the generated briefing and exposes a delivery rejection as a failed run", async () => {
  mocks.query.mockResolvedValue([{ automationId: "auto-test", name: "Briefing", task: "Brief", integrations: [], schedule: "30 7 * * *", timezone: "Australia/Hobart", nextRunAt: 0, notifyConversationId: "sms:+15550000101" }]);
  mocks.mutation.mockResolvedValue(null);
  mocks.spawn.mockResolvedValue({ status: "completed", result: "Today's briefing", agentId: "agent-test" });
  mocks.send.mockRejectedValue(new Error("Sendblue delivery failed: Unauthorized sender"));
  await tickAutomations();
  await vi.waitFor(() => expect(mocks.broadcast).toHaveBeenCalledWith("automation_failed", expect.anything()));
  const patches = mocks.mutation.mock.calls.map(([, args]) => args);
  expect(patches).toContainEqual(expect.objectContaining({ status: "failed", result: "Today's briefing", agentId: "agent-test", error: expect.stringContaining("Unauthorized sender") }));
  expect(patches.some((args) => args.status === "completed")).toBe(false);
  expect(mocks.broadcast).not.toHaveBeenCalledWith("automation_completed", expect.anything());
});

const savedMonitor = {
  automationId: "auto-monitor", name: "log file monitor + dashboard",
  task: "Read /Library/Logs and write /local/log-dashboard.html",
  integrations: [], schedule: "0 */4 * * *", conversationId: "chat-test",
  notifyConversationId: "sms:+15550000101", nextRunAt: 123456,
};

it("retries the exact saved local task without a capture, notification, or schedule change", async () => {
  mocks.query.mockResolvedValue(savedMonitor);
  mocks.spawn.mockResolvedValue({ status: "completed", result: "Dashboard updated", agentId: "agent-retry" });
  const result = await runAutomationNow("auto-monitor", "chat-test");
  expect(result).toMatchObject({ success: true, result: "Dashboard updated" });
  expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith({
    task: `AUTOMATION "${savedMonitor.name}": ${savedMonitor.task}`,
    integrations: [], conversationId: "chat-test", name: `auto:${savedMonitor.name}`,
  });
  expect(mocks.send).not.toHaveBeenCalled();
  const writes = mocks.mutation.mock.calls.map(([, args]) => args);
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatchObject({ automationId: "auto-monitor" });
  expect(writes[1]).toMatchObject({ status: "completed", agentId: "agent-retry" });
  expect(writes.some((args) => "nextRunAt" in args || "content" in args)).toBe(false);
});

it.each([null, { ...savedMonitor, conversationId: "another-chat" }])("rejects missing or other-conversation automations", async (automation) => {
  mocks.query.mockResolvedValue(automation);
  await expect(runAutomationNow("auto-monitor", "chat-test")).rejects.toThrow("not found");
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.mutation).not.toHaveBeenCalled();
});

it("reports an execution failure as failed in manual run history", async () => {
  mocks.query.mockResolvedValue(savedMonitor);
  mocks.spawn.mockResolvedValue({ status: "failed", result: "Permission denied", agentId: "agent-failed" });
  const result = await runAutomationNow("auto-monitor", "chat-test");
  expect(result).toMatchObject({ success: false, error: expect.stringContaining("Permission denied") });
  expect(mocks.mutation.mock.calls.at(-1)?.[1]).toMatchObject({ status: "failed", agentId: "agent-failed" });
  expect(mocks.send).not.toHaveBeenCalled();
});
