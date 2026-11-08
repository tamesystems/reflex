import {
  type AccessPolicy,
  accessPolicy,
  FULL_CONTROL,
  narrowerAccess,
  type Methods,
  requirePermitted,
  restrictInspection,
} from "@reflex/protocol"
import type { Controller, ControllerMethod } from "./controller.ts"

/**
 * The same controller, held to a policy. Whatever serves it (a socket, stdio, a bridge, a
 * journey) gets the policy enforced here, before the request reaches the session: a
 * refused request has no effect at all. Inspections show the actions a policy forbids
 * as unavailable, and `describe` reports the policy, so a peer can tell what it may do.
 */
export const restrictController = (controller: Controller, policy: AccessPolicy): Controller => {
  // Wrapping twice holds peers to both policies.
  const checked = narrowerAccess(controller.access ?? FULL_CONTROL, accessPolicy(policy))
  if (checked.kind === "control") {
    return controller
  }
  return {
    access: checked,
    request: async <M extends ControllerMethod>(
      method: M,
      params: Methods[M]["params"],
      options?: { readonly signal?: AbortSignal },
    ): Promise<Methods[M]["result"]> => {
      requirePermitted(checked, method, await targetOf(controller, method, params, options))
      const result = await controller.request(method, params, options)
      return shown(checked, method, result) as Methods[M]["result"]
    },
    subscribe: (listener, options) => controller.subscribe(listener, options),
    // The policy limits this peer; closing what it was handed is still the owner's call.
    close: () => controller.close(),
  }
}

/** What a request acts on, as `requirePermitted` judges it. */
const targetOf = async (
  controller: Controller,
  method: ControllerMethod,
  params: unknown,
  options: { readonly signal?: AbortSignal } | undefined,
): Promise<{ readonly action?: string; readonly cancelling?: string }> => {
  const record = params as { readonly action?: unknown; readonly operationId?: unknown }
  if (method === "app.dispatch") {
    return typeof record.action === "string" ? { action: record.action } : {}
  }
  if (method === "app.cancel" && typeof record.operationId === "string") {
    // Only the session knows which action an operation runs, so ask it first.
    const operation = await controller.request(
      "app.operation",
      { operationId: record.operationId as Methods["app.operation"]["params"]["operationId"] },
      options,
    )
    return { cancelling: operation.action }
  }
  return {}
}

const shown = (policy: AccessPolicy, method: ControllerMethod, result: unknown): unknown => {
  if (method === "app.inspect") {
    return restrictInspection(policy, result as Methods["app.inspect"]["result"])
  }
  if (method === "app.describe") {
    const described = result as Methods["app.describe"]["result"]
    return { ...described, access: narrowerAccess(described.access ?? FULL_CONTROL, policy) }
  }
  return result
}
