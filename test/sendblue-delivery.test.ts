import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverSendblueMessage } from "../server/sendblue-delivery.js";

const body = { number: "+15550000101", from_number: "+15550000100", content: "Test" };
const response = (value: object) => new Response(JSON.stringify(value));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Sendblue delivery confirmation", () => {
  it("rejects an HTTP error instead of reporting success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })));
    await expect(deliverSendblueMessage({}, body)).rejects.toThrow("HTTP 401");
  });

  it("rejects a delivery error in an HTTP 200 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ status: "ERROR", error_code: 401, error_message: "Unauthorized request to send from this number" })));
    await expect(deliverSendblueMessage({}, body)).rejects.toThrow("Unauthorized request to send from this number");
  });

  it("catches a rejection after the message was initially queued", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ status: "QUEUED", message_handle: "message-1" }))
      .mockResolvedValueOnce(response({ status: "ERROR", error_code: 4 }));
    vi.stubGlobal("fetch", fetchMock);
    const assertion = expect(deliverSendblueMessage({}, body)).rejects.toThrow("error 4");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("waits through SENT until delivery is confirmed", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ status: "QUEUED", message_handle: "message-1" }))
      .mockResolvedValueOnce(response({ status: "SENT" }))
      .mockResolvedValueOnce(response({ status: { status: "DELIVERED" }, message_handle: "message-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const promise = deliverSendblueMessage({}, body);
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports unconfirmed delivery without sending a duplicate", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => response({ status: "QUEUED", message_handle: "message-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const assertion = expect(deliverSendblueMessage({}, body)).rejects.toThrow("may still arrive");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("does not mistake an empty response for delivery", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({})));
    await expect(deliverSendblueMessage({}, body)).rejects.toThrow("omitted the message handle");
  });

  it("accepts a message still at SENT after the poll window (SMS recipients)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => response({ status: "SENT", message_handle: "message-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const promise = deliverSendblueMessage({}, body);
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("does not poll when poll is false, but still rejects an immediate error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: "QUEUED", message_handle: "message-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await deliverSendblueMessage({}, body, { poll: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(response({ status: "ERROR", error_message: "Rejected" }));
    await expect(deliverSendblueMessage({}, body, { poll: false })).rejects.toThrow("Rejected");
  });
});
