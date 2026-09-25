/**
 * Payment entity config — customer payments applied to invoices.
 *
 * Standard list/get/create/update flow through the generator. Two things are
 * hand-written here:
 *   - `qbo_payments_apply`: apply part of a payment's unapplied balance to an
 *     invoice, merging into any existing same-invoice line (QBO silently drops
 *     the prior application if a second line for the same invoice is appended).
 *   - `qbo_payments_void` / `qbo_payments_delete`: QBO ?operation= mutations.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getClient } from "../utils/client.js";
import { jsonText } from "./generator.js";
import { mergeExtras, operationExtras } from "./operations.js";
import type { EntityConfig, EntityExtras, EntityField } from "./types.js";

const paymentFields: EntityField[] = [
  {
    name: "CustomerRef",
    type: "object",
    required: true,
    description:
      'Customer reference object, e.g. {"value": "123"} where value is the customer ID',
  },
  {
    name: "TotalAmt",
    type: "number",
    required: true,
    description: "Total payment amount",
  },
  {
    name: "TxnDate",
    type: "string",
    description: "Transaction date (YYYY-MM-DD format)",
  },
  {
    name: "PaymentMethodRef",
    type: "object",
    description: 'Payment method reference object, e.g. {"value": "1"}',
  },
  {
    name: "DepositToAccountRef",
    type: "object",
    description:
      'Account the payment is deposited to, e.g. {"value": "35"}. When omitted, QBO routes the payment to Undeposited Funds.',
  },
  {
    name: "PrivateNote",
    type: "string",
    description: "Private note / memo (not shown to the customer)",
  },
  {
    name: "Line",
    type: "array",
    description:
      "Array of LinkedTxn entries linking this payment to invoices, e.g. [{Amount: 100, LinkedTxn: [{TxnId: '5', TxnType: 'Invoice'}]}]",
    items: { type: "object" },
  },
];

export const paymentConfig: EntityConfig = {
  name: "Payment",
  toolPrefix: "qbo_payments",
  description:
    "Payment management - list, get, create, update, and apply payments linked to invoices",
  list: { dateRange: true },
  get: { idParam: "paymentId" },
  create: { fields: paymentFields },
  update: { idParam: "paymentId", fields: paymentFields },
};

// --- qbo_payments_apply ------------------------------------------------------

/** Round to whole cents for exact-equality comparisons against QBO balances. */
function cents(n: number): number {
  return Math.round(n * 100);
}

/** Round a running total back to a 2-decimal currency amount. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface QboLinkedTxn {
  TxnId?: string;
  TxnType?: string;
}

interface QboPaymentLine {
  Amount?: number;
  LinkedTxn?: QboLinkedTxn[];
  [key: string]: unknown;
}

interface QboPayment {
  Id?: string;
  SyncToken?: string;
  TotalAmt?: number;
  UnappliedAmt?: number;
  Line?: QboPaymentLine[];
  [key: string]: unknown;
}

interface QboPaymentEnvelope {
  Payment?: QboPayment;
}

interface QboInvoiceEnvelope {
  Invoice?: { Balance?: number; [key: string]: unknown };
}

const applyTool: Tool = {
  name: "qbo_payments_apply",
  description:
    "Apply an amount from an existing payment's unapplied balance to an open invoice. " +
    "If the payment already links this invoice, the existing line's amount is increased " +
    "(appending a second line for the same invoice makes QBO silently drop the prior " +
    "application). Fails if the amount exceeds the payment's unapplied balance or the " +
    "invoice's open balance. Returns the post-write unapplied amount and invoice balance.",
  inputSchema: {
    type: "object",
    properties: {
      paymentId: { type: "string", description: "The Payment ID to apply from" },
      invoiceId: { type: "string", description: "The Invoice ID to apply to" },
      amount: {
        type: "number",
        description:
          "Amount to apply. Must be > 0 and no greater than both the payment's unapplied balance and the invoice's open balance.",
      },
    },
    required: ["paymentId", "invoiceId", "amount"],
  },
};

const applyHandler: EntityExtras["handlers"] = {
  qbo_payments_apply: async (args) => {
    const paymentId = String((args as { paymentId: unknown }).paymentId);
    const invoiceId = String((args as { invoiceId: unknown }).invoiceId);
    const rawAmount = (args as { amount: unknown }).amount;
    const amount = typeof rawAmount === "number" ? rawAmount : Number(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(
        `Invalid amount: expected a positive number, got ${JSON.stringify(rawAmount)}`
      );
    }

    const client = getClient();

    const paymentEnv = (await client.get(`payment/${paymentId}`)) as QboPaymentEnvelope;
    const payment = paymentEnv.Payment;
    if (!payment) throw new Error(`Payment ${paymentId} not found`);

    const invoiceEnv = (await client.get(`invoice/${invoiceId}`)) as QboInvoiceEnvelope;
    const invoice = invoiceEnv.Invoice;
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

    const unapplied = Number(payment.UnappliedAmt ?? 0);
    const invoiceBalance = Number(invoice.Balance ?? 0);

    if (cents(amount) > cents(unapplied)) {
      throw new Error(
        `amount ${amount} exceeds payment ${paymentId} unapplied balance ${unapplied}`
      );
    }
    if (cents(amount) > cents(invoiceBalance)) {
      throw new Error(
        `amount ${amount} exceeds invoice ${invoiceId} open balance ${invoiceBalance}`
      );
    }

    const lines: QboPaymentLine[] = Array.isArray(payment.Line)
      ? payment.Line.map((l) => ({ ...l }))
      : [];
    const idx = lines.findIndex(
      (l) =>
        Array.isArray(l.LinkedTxn) &&
        l.LinkedTxn.some(
          (t) => t.TxnType === "Invoice" && String(t.TxnId) === invoiceId
        )
    );

    if (idx >= 0) {
      // Merge into the one existing line for this invoice. Appending a second
      // same-invoice line makes QBO treat it as a replacement, wiping the
      // prior application (observed on payment 10085 in production).
      const existing = Number(lines[idx].Amount ?? 0);
      lines[idx] = { ...lines[idx], Amount: round2(existing + amount) };
    } else {
      lines.push({
        Amount: round2(amount),
        LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }],
      });
    }

    // Full update: post the entire payment back with the modified lines.
    const updated: QboPayment = { ...payment, Line: lines };
    const postEnv = (await client.post("payment", updated)) as QboPaymentEnvelope;
    const saved = postEnv.Payment;

    // Re-read the invoice so the returned balance reflects the write.
    const afterEnv = (await client.get(`invoice/${invoiceId}`)) as QboInvoiceEnvelope;

    return jsonText({
      paymentId,
      unappliedAmt: saved?.UnappliedAmt,
      invoiceId,
      invoiceBalance: afterEnv.Invoice?.Balance,
    });
  },
};

export const paymentExtras: EntityExtras = mergeExtras(
  { tools: [applyTool], handlers: applyHandler },
  operationExtras({
    prefix: "qbo_payments",
    path: "payment",
    label: "payment",
    idParam: "paymentId",
    void: true,
    delete: true,
  })
);
