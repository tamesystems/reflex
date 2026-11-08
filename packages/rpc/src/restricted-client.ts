import {
  type AccessPolicy,
  accessPolicy,
  type Method,
  narrowerAccess,
  type Methods,
  requirePermitted,
  restrictInspection,
} from "@reflex/protocol"
import type { Client, RequestOptions } from "./client.ts"

/**
 * A client that refuses, before sending, what a policy forbids. It is a guard for the
 * process that holds it, such as an MCP server limiting its agent, not a boundary: whoever
 * can open the session's socket can connect without it. Sessions enforce a policy with
 * `restrictController` or a connection's `access` option.
 */
export const restrictClient = (client: Client, policy: AccessPolicy): Client => {
  const checked = accessPolicy(policy)
  if (checked.kind === "control") {
    return client
  }
  const request = async <M extends Method>(
    method: M,
    params: Methods[M]["params"],
    options?: RequestOptions,
  ): Promise<Methods[M]["result"]> => {
    const record = params as { readonly action?: unknown; readonly operationId?: unknown }
    let cancelling: string | undefined
    if (method === "app.cancel" && typeof record.operationId === "string") {
      const operation = await client.request(
        "app.operation",
        { operationId: record.operationId as Methods["app.operation"]["params"]["operationId"] },
        options,
      )
      cancelling = operation.action
    }
    requirePermitted(checked, method, {
      ...(typeof record.action === "string" ? { action: record.action } : {}),
      ...(cancelling === undefined ? {} : { cancelling }),
    })
    const result = await client.request(method, params, options)
    if (method === "app.inspect") {
      return restrictInspection(checked, result as Methods["app.inspect"]["result"]) as never
    }
    if (method === "app.describe") {
      const described = result as Methods["app.describe"]["result"]
      const access = narrowerAccess(described.access ?? { kind: "control" }, checked)
      return { ...described, access } as never
    }
    return result
  }
  return {
    request,
    onEvent: (listener) => client.onEvent(listener),
    ended: client.ended,
    get isEnded() {
      return client.isEnded
    },
    close: () => client.close(),
  }
}
