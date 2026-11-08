/**
 * What a peer may do with a session. Observing and acting are different powers: an agent
 * diagnosing a bug, a dashboard or a recorder can watch without being able to change
 * anything, and a peer that may act can be held to the actions it needs.
 *
 * One pure check decides every request, so each place that enforces a policy (a
 * restricted controller, a restricted client, the MCP server) applies the same rule.
 */
import {
  type ActionDescriptor,
  ErrorCode,
  type InspectResult,
  type Method,
  ProtocolError,
} from "./contracts.ts"
import { ACCESS_ACTION_CHARACTERS_MAX, ACCESS_ACTIONS_MAX } from "./limits.ts"

export type AccessPolicy =
  /** Everything, as the session's owner has. */
  | { readonly kind: "control" }
  /** Read state, wait and subscribe; change nothing. */
  | { readonly kind: "observe" }
  /** Observe, and dispatch (or cancel) only the actions named. */
  | { readonly kind: "actions"; readonly actions: ReadonlyArray<string> }

export const FULL_CONTROL: AccessPolicy = { kind: "control" }

/** Methods that change nothing: open to every policy. */
const OBSERVING: ReadonlySet<Method> = new Set([
  "app.describe",
  "app.inspect",
  "app.operation",
  "app.wait",
  "app.sample",
  "app.subscribe",
  "app.unsubscribe",
])

/** Refused for anything less than control, whatever actions are named. */
const CONTROLLING: ReadonlySet<Method> = new Set([
  "app.reset",
  "app.advanceTime",
  "session.shutdown",
])

/** The policy, checked: no more names than the limit, each a usable action name. */
export const accessPolicy = (policy: AccessPolicy): AccessPolicy => {
  if (policy.kind !== "actions") {
    return policy
  }
  const { actions } = policy
  if (actions.length === 0 || actions.length > ACCESS_ACTIONS_MAX) {
    throw new Error(`An action allowlist names 1 to ${ACCESS_ACTIONS_MAX} actions`)
  }
  for (const action of actions) {
    if (action.length === 0 || action.length > ACCESS_ACTION_CHARACTERS_MAX) {
      throw new Error(`Action names are 1 to ${ACCESS_ACTION_CHARACTERS_MAX} characters`)
    }
  }
  return { kind: "actions", actions: [...new Set(actions)] }
}

/** What a peer may do when two policies apply to it, as through a restricted client of a restricted session. */
export const narrowerAccess = (a: AccessPolicy, b: AccessPolicy): AccessPolicy => {
  if (a.kind === "control") {
    return b
  }
  if (b.kind === "control") {
    return a
  }
  if (a.kind === "observe" || b.kind === "observe") {
    return { kind: "observe" }
  }
  const both = a.actions.filter((action) => b.actions.includes(action))
  return both.length === 0 ? { kind: "observe" } : { kind: "actions", actions: both }
}

const notPermitted = (what: string): ProtocolError =>
  new ProtocolError(ErrorCode.NotPermitted, `${what} is not permitted on this connection`)

const allows = (policy: AccessPolicy, action: string): boolean =>
  policy.kind === "control" || (policy.kind === "actions" && policy.actions.includes(action))

/**
 * Throws `NotPermitted` unless the policy allows this request. A dispatch is judged by
 * its action's name. A cancel is judged by the action of the operation it names, which
 * only the session knows, so the caller looks that up and passes it as `cancelling`.
 */
export const requirePermitted = (
  policy: AccessPolicy,
  method: Method,
  request: { readonly action?: string; readonly cancelling?: string } = {},
): void => {
  if (policy.kind === "control" || OBSERVING.has(method)) {
    return
  }
  if (CONTROLLING.has(method)) {
    throw notPermitted(`"${method}"`)
  }
  if (method === "app.dispatch") {
    const action = request.action ?? ""
    if (!allows(policy, action)) {
      throw notPermitted(`Action "${action.slice(0, ACCESS_ACTION_CHARACTERS_MAX)}"`)
    }
    return
  }
  if (method === "app.cancel") {
    const action = request.cancelling ?? ""
    if (!allows(policy, action)) {
      throw notPermitted(`Cancelling "${action.slice(0, ACCESS_ACTION_CHARACTERS_MAX)}"`)
    }
    return
  }
  throw notPermitted(`"${method}"`)
}

const REFUSED_REASON = "Not permitted on this connection"

const restrictAction = <A extends ActionDescriptor>(
  policy: AccessPolicy,
  name: string,
  descriptor: A,
): A => {
  if (allows(policy, name) || !descriptor.available) {
    return descriptor
  }
  return { ...descriptor, available: false, unavailableReason: REFUSED_REASON }
}

const restrictActions = (
  policy: AccessPolicy,
  actions: { readonly [name: string]: ActionDescriptor },
) =>
  Object.fromEntries(
    Object.entries(actions).map(([name, descriptor]) => [
      name,
      restrictAction(policy, name, descriptor),
    ]),
  )

/**
 * The same inspection, as this peer may use it: an action it may not run is shown as
 * unavailable, and says why. Nothing is hidden: observing includes seeing what exists.
 */
export const restrictInspection = (policy: AccessPolicy, result: InspectResult): InspectResult => {
  if (policy.kind === "control") {
    return result
  }
  const { node, ambient, tree } = result
  return {
    ...result,
    node: node === null ? null : { ...node, actions: restrictActions(policy, node.actions) },
    ambient: ambient.map((entry) => restrictAction(policy, entry.action, entry)),
    ...(tree === undefined
      ? {}
      : {
          tree: tree.map((each) => ({ ...each, actions: restrictActions(policy, each.actions) })),
        }),
  }
}
