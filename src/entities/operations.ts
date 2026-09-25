/**
 * Void / delete operation extras.
 *
 * QBO exposes void and hard-delete as POST to the entity path with an
 * `?operation=void` / `?operation=delete` query parameter and a minimal
 * `{Id, SyncToken}` body — they don't fit the declarative list/get/create/
 * update shape in EntityConfig, so they're emitted here as EntityExtras and
 * merged into the entity's own extras.
 *
 * Both are mutations: their tool names carry the `_void` / `_delete` suffix so
 * the same write-gating that recognizes `_create` / `_update` applies.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getClient } from "../utils/client.js";
import { jsonText } from "./generator.js";
import type { EntityExtras, ExtraHandler } from "./types.js";

export interface OperationSpec {
  /** Tool-name prefix, e.g. "qbo_payments". */
  prefix: string;
  /** REST path segment for the POST, e.g. "payment". */
  path: string;
  /** Human label used in tool descriptions, e.g. "payment". */
  label: string;
  /** Name of the id parameter on the tool, e.g. "paymentId". */
  idParam: string;
  /** Emit a `{prefix}_void` tool ( ?operation=void ). */
  void?: boolean;
  /** Emit a `{prefix}_delete` tool ( ?operation=delete ). */
  delete?: boolean;
}

function idSyncSchema(idParam: string, label: string, verb: string): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      [idParam]: {
        type: "string",
        description: `The ${label} ID to ${verb}`,
      },
      SyncToken: {
        type: "string",
        description:
          "Current SyncToken of the record (required by QBO; fetch the record first to obtain it)",
      },
    },
    required: [idParam, "SyncToken"],
  };
}

function operationHandler(path: string, operation: "void" | "delete", idParam: string): ExtraHandler {
  return async (args) => {
    const Id = args[idParam] as string;
    const SyncToken = args.SyncToken as string;
    const result = await getClient().post(path, { Id, SyncToken }, { operation });
    return jsonText(result);
  };
}

/**
 * Build the void/delete tools + handlers for one entity. Merge the returned
 * `tools` and `handlers` into the entity's existing EntityExtras (or use as
 * the extras directly when the entity has none).
 */
export function operationExtras(spec: OperationSpec): Required<Pick<EntityExtras, "tools" | "handlers">> {
  const tools: Tool[] = [];
  const handlers: Record<string, ExtraHandler> = {};

  if (spec.void) {
    const name = `${spec.prefix}_void`;
    tools.push({
      name,
      description:
        `Void an existing ${spec.label} in QuickBooks Online. The record is kept ` +
        `but zeroed out and marked Voided. Requires Id and SyncToken (fetch the record first).`,
      inputSchema: idSyncSchema(spec.idParam, spec.label, "void"),
    });
    handlers[name] = operationHandler(spec.path, "void", spec.idParam);
  }

  if (spec.delete) {
    const name = `${spec.prefix}_delete`;
    tools.push({
      name,
      description:
        `Permanently delete an existing ${spec.label} in QuickBooks Online. This cannot ` +
        `be undone. Requires Id and SyncToken (fetch the record first).`,
      inputSchema: idSyncSchema(spec.idParam, spec.label, "delete"),
    });
    handlers[name] = operationHandler(spec.path, "delete", spec.idParam);
  }

  return { tools, handlers };
}

/**
 * Merge two EntityExtras into one, concatenating `tools` and shallow-merging
 * `handlers`. Used to fold operation extras into an entity's own extras.
 */
export function mergeExtras(a: EntityExtras, b: EntityExtras): EntityExtras {
  return {
    tools: [...(a.tools ?? []), ...(b.tools ?? [])],
    handlers: { ...(a.handlers ?? {}), ...(b.handlers ?? {}) },
  };
}
