import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { boopUserId, getComposio, listConnectedToolkits } from "../composio.js";
import { fetchStoredBytes } from "../images/content-blocks.js";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { registerIntegration } from "./registry.js";

const NAMESPACE = "xero-receipts";

// Composio's default auto-upload allowlist (dangerouslyAllowAutoUploadDownloadFiles
// in server/composio.ts) is `~/.composio/temp` — write receipt files there so the
// SDK's file_uploadable auto-upload can read them without an allowlist override.
const UPLOAD_STAGING_DIR = path.join(os.homedir(), ".composio", "temp");

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

interface XeroResult {
  data?: unknown;
  error?: unknown;
  successful?: boolean;
}

export function formatXeroReceiptFailure(
  err: unknown,
  transactionId?: string,
): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!transactionId) return `[xero-receipts error] ${message}`;
  return (
    `[xero-receipts partial success] Xero transaction ${transactionId} was created, ` +
    `but attaching the receipt failed: ${message}. The transaction remains in Xero and ` +
    `needs the receipt attached manually or the transaction reviewed there before retrying. ` +
    `Do not create another transaction for this receipt automatically.`
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function xero(
  toolSlug: string,
  args: Record<string, unknown>,
): Promise<XeroResult> {
  const composio = getComposio();
  if (!composio) throw new Error("COMPOSIO_API_KEY not set");
  const result = (await composio.tools.execute(toolSlug, {
    userId: boopUserId(),
    arguments: args,
    dangerouslySkipVersionCheck: true,
  })) as XeroResult;
  if (result.successful === false) {
    throw new Error(`${toolSlug} failed: ${JSON.stringify(result.error ?? result)}`);
  }
  return result;
}

async function findOrCreateContactId(contactName: string): Promise<string> {
  const trimmed = contactName.trim();
  const search = await xero("XERO_GET_CONTACTS", { searchTerm: trimmed, summaryOnly: true });
  const contacts = asArray(asRecord(search.data)?.Contacts);
  const exact = contacts.find((c) => {
    const rec = asRecord(c);
    return typeof rec?.Name === "string" && rec.Name.trim().toLowerCase() === trimmed.toLowerCase();
  });
  const existingId = asRecord(exact)?.ContactID ?? asRecord(contacts[0])?.ContactID;
  if (typeof existingId === "string") return existingId;

  const created = await xero("XERO_CREATE_CONTACT", { Name: trimmed, IsSupplier: true });
  const createdContacts = asArray(asRecord(created.data)?.Contacts);
  const newId = asRecord(createdContacts[0])?.ContactID;
  if (typeof newId !== "string") {
    throw new Error(`Xero didn't return a ContactID for new contact "${trimmed}": ${JSON.stringify(created)}`);
  }
  return newId;
}

export function createXeroReceiptTools(): RuntimeTool[] {
  return [
    defineRuntimeTool(
      NAMESPACE,
      "create_receipt_transaction",
      `Create a Xero Spend Money (bank transaction) record for a receipt, and attach the original receipt image to it. This is the ONLY way to commit a receipt to Xero. Call this ONLY after the user has confirmed the extracted details via the draft flow (save_draft -> user confirms -> send_draft). If attachment upload fails after creation, the result includes the real transaction id and must be surfaced to the user; never retry automatically because that could duplicate the transaction.`,
      {
        contactName: z.string().describe("Vendor/payee name as it should appear in Xero (e.g. 'Bunnings Warehouse')."),
        date: z.string().describe("Transaction date, YYYY-MM-DD."),
        description: z.string().describe("Line item description shown on the transaction."),
        totalAmount: z.number().describe("Total amount on the receipt, as a positive number."),
        accountCode: z.string().describe("Xero expense account code for the line item (from XERO_LIST_ACCOUNTS)."),
        bankAccountCode: z.string().describe("Xero bank account code to spend from (from XERO_LIST_ACCOUNTS, Type==BANK)."),
        taxType: z.string().describe("Xero TaxType code for the line item (from XERO_LIST_TAX_RATES), e.g. 'NONE' or 'INPUT2'."),
        receiptStorageId: z.string().describe("Convex storage id of the original receipt image."),
        currencyCode: z.string().optional().describe("Currency code, e.g. AUD. Omit to use the org default."),
        reference: z.string().optional().describe("Optional reference text for the transaction."),
      },
      async (args) => {
        let tempFilePath: string | undefined;
        let transactionId: string | undefined;
        try {
          // Fetch and stage the receipt image FIRST, before touching Xero at
          // all. A missing/empty/unresolvable receiptStorageId must fail here
          // — not after a real bank transaction already exists with nothing
          // to attach it to, which would leave an orphaned real record in the
          // user's books that they'd have to notice and delete manually.
          if (!args.receiptStorageId.trim()) {
            throw new Error(
              "receiptStorageId is empty — refusing to create a Xero transaction with no receipt to attach. " +
                "This usually means the draft was staged without a real image reference; reject this draft and redo it from the original receipt photo.",
            );
          }
          const { bytes, mediaType } = await fetchStoredBytes(args.receiptStorageId);
          const ext = EXT_BY_MEDIA_TYPE[mediaType] ?? "bin";
          await mkdir(UPLOAD_STAGING_DIR, { recursive: true });
          tempFilePath = path.join(UPLOAD_STAGING_DIR, `receipt-${randomUUID()}.${ext}`);
          await writeFile(tempFilePath, bytes);

          const contactId = await findOrCreateContactId(args.contactName);

          const created = await xero("XERO_CREATE_BANK_TRANSACTION", {
            Date: args.date,
            Type: "SPEND",
            Status: "AUTHORISED",
            ContactID: contactId,
            LineItems: [
              {
                Description: args.description,
                UnitAmount: args.totalAmount,
                AccountCode: args.accountCode,
                TaxType: args.taxType,
                Quantity: 1,
              },
            ],
            BankAccountCode: args.bankAccountCode,
            Reference: args.reference,
            ...(args.currencyCode ? { CurrencyCode: args.currencyCode } : {}),
          });
          const createdTxns = asArray(asRecord(created.data)?.BankTransactions);
          const returnedTransactionId = asRecord(createdTxns[0])?.BankTransactionID;
          if (typeof returnedTransactionId !== "string") {
            throw new Error(
              `Xero didn't return a BankTransactionID: ${JSON.stringify(created)}`,
            );
          }
          transactionId = returnedTransactionId;

          await xero("XERO_UPLOAD_ATTACHMENT", {
            entity_type: "BankTransactions",
            entity_id: transactionId,
            filename: `receipt.${ext}`,
            file_to_upload: tempFilePath,
          });

          return runtimeText(
            `Created Xero Spend Money transaction for ${args.contactName} ($${args.totalAmount.toFixed(2)}${
              args.currencyCode ? ` ${args.currencyCode}` : ""
            }, ${args.date}) and attached the receipt image. BankTransactionID: ${transactionId}`,
          );
        } catch (err) {
          return runtimeText(formatXeroReceiptFailure(err, transactionId), false);
        } finally {
          if (tempFilePath) await rm(tempFilePath, { force: true });
        }
      },
    ),
  ];
}

export function createXeroReceiptsMcp() {
  return createClaudeMcpServer(NAMESPACE, createXeroReceiptTools());
}

export function registerXeroReceiptsIntegration(): void {
  registerIntegration({
    name: NAMESPACE,
    description:
      "Commits a confirmed receipt draft to Xero as a Spend Money transaction with the original image attached. Use only after user confirmation via send_draft.",
    isEnabled: async () =>
      (await listConnectedToolkits()).some((c) => c.slug === "xero" && c.status === "ACTIVE"),
    createServer: async () => createXeroReceiptsMcp(),
    createTools: async () => createXeroReceiptTools(),
  });
}
