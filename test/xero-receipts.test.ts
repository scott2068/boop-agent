import { describe, expect, it } from "vitest";
import { formatXeroReceiptFailure } from "../server/integrations/xero-receipts.js";

describe("formatXeroReceiptFailure", () => {
  it("returns a normal failure before a transaction exists", () => {
    expect(formatXeroReceiptFailure(new Error("receipt missing"))).toBe(
      "[xero-receipts error] receipt missing",
    );
  });

  it("identifies a created transaction when attachment upload fails", () => {
    const result = formatXeroReceiptFailure(
      new Error("attachment upload unavailable"),
      "txn-123",
    );
    expect(result).toContain("[xero-receipts partial success]");
    expect(result).toContain("txn-123");
    expect(result).toContain("remains in Xero");
    expect(result).toContain("Do not create another transaction");
  });
});
