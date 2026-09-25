/**
 * Unit tests for the payment write surface added in issue #1:
 *   - the qbo_payments_update config (DepositToAccountRef + PrivateNote)
 *   - qbo_payments_apply: the same-invoice merge case and the over-apply guards
 *   - the void/delete request shape (?operation= + {Id, SyncToken})
 *   - the search SQL no longer emitting an ESCAPE clause, and startPosition
 *     accepting offsets beyond 1000
 *
 * getClient() is mocked so the handlers never touch the network; the fake
 * client records the path/body/params each op was called with.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    get: vi.fn(),
    post: vi.fn(),
    query: vi.fn(),
  },
}));

vi.mock("../utils/client.js", () => ({
  getClient: () => mockClient,
}));

import {
  generateEntityTools,
  makeEntityDispatcher,
} from "../entities/generator.js";
import { paymentConfig, paymentExtras } from "../entities/payment.js";
import { invoiceConfig, invoiceExtras } from "../entities/invoice.js";
import { depositConfig, depositExtras } from "../entities/deposit.js";
import {
  journalEntryConfig,
  journalEntryExtras,
} from "../entities/journal-entry.js";
import type { EntityConfig } from "../entities/types.js";

const paymentDispatch = makeEntityDispatcher(paymentConfig, paymentExtras);

function parse(result: { content: { text: string }[] } | null) {
  return JSON.parse(result!.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("qbo_payments_update config", () => {
  const tools = generateEntityTools(paymentConfig);

  it("emits an update tool with Id + SyncToken required", () => {
    const update = tools.find((t) => t.name === "qbo_payments_update");
    expect(update).toBeDefined();
    const req = (update!.inputSchema as { required: string[] }).required;
    expect(req).toContain("paymentId");
    expect(req).toContain("SyncToken");
  });

  it("exposes DepositToAccountRef + PrivateNote on both create and update", () => {
    for (const name of ["qbo_payments_create", "qbo_payments_update"]) {
      const tool = tools.find((t) => t.name === name)!;
      const props = (tool.inputSchema as { properties: Record<string, unknown> })
        .properties;
      expect(props).toHaveProperty("DepositToAccountRef");
      expect(props).toHaveProperty("PrivateNote");
    }
  });
});

describe("qbo_payments_apply", () => {
  it("merges into the existing same-invoice line instead of appending", async () => {
    // Production scenario from payment 10085: $673.20 already applied to
    // invoice 5, apply another $0.10.
    mockClient.get.mockImplementation(async (path: string) => {
      if (path.startsWith("payment/")) {
        return {
          Payment: {
            Id: "10085",
            SyncToken: "3",
            TotalAmt: 673.3,
            UnappliedAmt: 0.1,
            Line: [
              { Amount: 673.2, LinkedTxn: [{ TxnId: "5", TxnType: "Invoice" }] },
            ],
          },
        };
      }
      return { Invoice: { Id: "5", Balance: 0.1 } };
    });
    mockClient.post.mockResolvedValue({ Payment: { Id: "10085", UnappliedAmt: 0 } });

    const result = await paymentDispatch("qbo_payments_apply", {
      paymentId: "10085",
      invoiceId: "5",
      amount: 0.1,
    });

    // One POST to /payment carrying a SINGLE merged line worth 673.30.
    expect(mockClient.post).toHaveBeenCalledTimes(1);
    const [path, body] = mockClient.post.mock.calls[0];
    expect(path).toBe("payment");
    expect(body.Line).toHaveLength(1);
    expect(body.Line[0].Amount).toBeCloseTo(673.3, 5);
    expect(body.Line[0].LinkedTxn[0]).toEqual({ TxnId: "5", TxnType: "Invoice" });

    // Returns the re-read balances.
    expect(parse(result)).toEqual({
      paymentId: "10085",
      unappliedAmt: 0,
      invoiceId: "5",
      invoiceBalance: 0.1,
    });
  });

  it("appends a new line when the invoice is not already linked", async () => {
    mockClient.get.mockImplementation(async (path: string) => {
      if (path.startsWith("payment/")) {
        return {
          Payment: {
            Id: "20",
            SyncToken: "0",
            UnappliedAmt: 500,
            Line: [
              { Amount: 100, LinkedTxn: [{ TxnId: "9", TxnType: "Invoice" }] },
            ],
          },
        };
      }
      return { Invoice: { Id: "7", Balance: 250 } };
    });
    mockClient.post.mockResolvedValue({ Payment: { Id: "20", UnappliedAmt: 300 } });

    await paymentDispatch("qbo_payments_apply", {
      paymentId: "20",
      invoiceId: "7",
      amount: 200,
    });

    const body = mockClient.post.mock.calls[0][1];
    expect(body.Line).toHaveLength(2);
    expect(body.Line[1]).toEqual({
      Amount: 200,
      LinkedTxn: [{ TxnId: "7", TxnType: "Invoice" }],
    });
  });

  it("rejects an amount greater than the payment's unapplied balance", async () => {
    mockClient.get.mockImplementation(async (path: string) => {
      if (path.startsWith("payment/")) {
        return { Payment: { Id: "1", SyncToken: "0", UnappliedAmt: 50, Line: [] } };
      }
      return { Invoice: { Id: "2", Balance: 1000 } };
    });

    await expect(
      paymentDispatch("qbo_payments_apply", {
        paymentId: "1",
        invoiceId: "2",
        amount: 75,
      })
    ).rejects.toThrow(/unapplied balance/);
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  it("rejects an amount greater than the invoice's open balance", async () => {
    mockClient.get.mockImplementation(async (path: string) => {
      if (path.startsWith("payment/")) {
        return { Payment: { Id: "1", SyncToken: "0", UnappliedAmt: 1000, Line: [] } };
      }
      return { Invoice: { Id: "2", Balance: 40 } };
    });

    await expect(
      paymentDispatch("qbo_payments_apply", {
        paymentId: "1",
        invoiceId: "2",
        amount: 75,
      })
    ).rejects.toThrow(/open balance/);
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  it("rejects a non-positive amount before any network call", async () => {
    await expect(
      paymentDispatch("qbo_payments_apply", {
        paymentId: "1",
        invoiceId: "2",
        amount: 0,
      })
    ).rejects.toThrow(/Invalid amount/);
    expect(mockClient.get).not.toHaveBeenCalled();
  });
});

describe("void / delete request shape", () => {
  it("qbo_payments_void posts ?operation=void with {Id, SyncToken}", async () => {
    mockClient.post.mockResolvedValue({ Payment: {} });
    await paymentDispatch("qbo_payments_void", {
      paymentId: "10085",
      SyncToken: "3",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "payment",
      { Id: "10085", SyncToken: "3" },
      { operation: "void" }
    );
  });

  it("qbo_payments_delete posts ?operation=delete with {Id, SyncToken}", async () => {
    mockClient.post.mockResolvedValue({ Payment: {} });
    await paymentDispatch("qbo_payments_delete", {
      paymentId: "10085",
      SyncToken: "3",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "payment",
      { Id: "10085", SyncToken: "3" },
      { operation: "delete" }
    );
  });

  it("qbo_invoices_void targets the invoice path", async () => {
    mockClient.post.mockResolvedValue({ Invoice: {} });
    const dispatch = makeEntityDispatcher(invoiceConfig, invoiceExtras);
    await dispatch("qbo_invoices_void", { invoiceId: "130", SyncToken: "1" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "invoice",
      { Id: "130", SyncToken: "1" },
      { operation: "void" }
    );
  });

  it("qbo_deposits_delete targets the deposit path", async () => {
    mockClient.post.mockResolvedValue({ Deposit: {} });
    const dispatch = makeEntityDispatcher(depositConfig, depositExtras);
    await dispatch("qbo_deposits_delete", { depositId: "44", SyncToken: "2" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "deposit",
      { Id: "44", SyncToken: "2" },
      { operation: "delete" }
    );
  });

  it("qbo_journal_entries_delete targets the journalentry path", async () => {
    mockClient.post.mockResolvedValue({ JournalEntry: {} });
    const dispatch = makeEntityDispatcher(journalEntryConfig, journalEntryExtras);
    await dispatch("qbo_journal_entries_delete", {
      journalEntryId: "88",
      SyncToken: "0",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "journalentry",
      { Id: "88", SyncToken: "0" },
      { operation: "delete" }
    );
  });

  it("advertises the expected void/delete tools", () => {
    const names = paymentExtras.tools!.map((t) => t.name);
    expect(names).toContain("qbo_payments_apply");
    expect(names).toContain("qbo_payments_void");
    expect(names).toContain("qbo_payments_delete");
  });
});

describe("generated search SQL", () => {
  const searchConfig: EntityConfig = {
    name: "Widget",
    toolPrefix: "qbo_widgets",
    description: "search-only entity for the SQL shape test",
    search: { field: "Name" },
  };
  const dispatch = makeEntityDispatcher(searchConfig);

  it("omits the ESCAPE clause QBO rejects, and quote-escapes the term", async () => {
    mockClient.query.mockResolvedValue({ QueryResponse: {} });
    await dispatch("qbo_widgets_search", { term: "O'Brien" });
    const sql = mockClient.query.mock.calls[0][0] as string;
    expect(sql).not.toContain("ESCAPE");
    expect(sql).toContain("LIKE '%O''Brien%'");
  });

  it("accepts a startPosition beyond 1000", async () => {
    mockClient.query.mockResolvedValue({ QueryResponse: {} });
    await dispatch("qbo_widgets_search", { term: "x", startPosition: 5000 });
    const sql = mockClient.query.mock.calls[0][0] as string;
    expect(sql).toContain("STARTPOSITION 5000");
  });
});
