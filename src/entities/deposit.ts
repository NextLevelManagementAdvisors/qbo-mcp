/**
 * Deposit entity config — bank deposits aggregating one or more receipts.
 *
 * Lines either reference linked transactions (LinkedTxn from Undeposited
 * Funds) or are direct deposit lines (DepositLineDetail with AccountRef).
 *
 * IMPORTANT — updating deposit lines: a QBO full-update will NOT remove an
 * existing `DepositLineDetail` line. Sending an updated `Line` array that omits
 * a previously-present DepositLineDetail line leaves that line in place. To
 * relink a deposit line to a Payment, do NOT try to drop the old line: add the
 * new `LinkedTxn` line AND set the old line's `Amount` to 0 (verified against
 * production). The deposit total stays correct because the zeroed line
 * contributes nothing.
 */

import { mergeExtras, operationExtras } from "./operations.js";
import type { EntityConfig, EntityExtras, EntityField } from "./types.js";

const depositFields: EntityField[] = [
  {
    name: "DepositToAccountRef",
    type: "object",
    required: true,
    description: 'Bank account receiving the deposit, e.g. {"value": "35"}',
  },
  {
    name: "Line",
    type: "array",
    required: true,
    description:
      'Deposit lines. Each line is either {Amount, DetailType: "DepositLineDetail", DepositLineDetail: {AccountRef, Entity?, PaymentMethodRef?}} OR {Amount, LinkedTxn: [{TxnId, TxnType}]} for linked transactions.',
    items: { type: "object" },
  },
  { name: "TxnDate", type: "string", description: "Deposit date (YYYY-MM-DD)" },
  { name: "DocNumber", type: "string", description: "Deposit reference number" },
  { name: "PrivateNote", type: "string", description: "Private note" },
  {
    name: "CashBack",
    type: "object",
    description:
      'Optional cash-back amount: {Amount, AccountRef: {value}, Memo?}',
  },
];

export const depositConfig: EntityConfig = {
  name: "Deposit",
  toolPrefix: "qbo_deposits",
  description: "Bank deposits - list, get, create, update, delete deposits aggregating receipts",
  list: { dateRange: true },
  get: { idParam: "depositId" },
  create: { fields: depositFields },
  update: { idParam: "depositId", fields: depositFields },
};

export const depositExtras: EntityExtras = mergeExtras(
  {},
  operationExtras({
    prefix: "qbo_deposits",
    path: "deposit",
    label: "deposit",
    idParam: "depositId",
    delete: true,
  })
);
