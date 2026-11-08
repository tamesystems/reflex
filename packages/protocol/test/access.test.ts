import { expect, test } from "bun:test"
import {
  ACCESS_ACTIONS_MAX,
  type AccessPolicy,
  accessPolicy,
  ErrorCode,
  type InspectResult,
  type Method,
  narrowerAccess,
  type NodeId,
  requirePermitted,
  restrictInspection,
  resultParsers,
} from "@reflex/protocol"

const control: AccessPolicy = { kind: "control" }
const observe: AccessPolicy = { kind: "observe" }
const onlyAdd: AccessPolicy = { kind: "actions", actions: ["Add"] }

const permitted = (
  policy: AccessPolicy,
  method: Method,
  request?: { readonly action?: string; readonly cancelling?: string },
): boolean => {
  try {
    requirePermitted(policy, method, request)
    return true
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: ErrorCode.NotPermitted })
    return false
  }
}

const OBSERVING: ReadonlyArray<Method> = [
  "app.describe",
  "app.inspect",
  "app.operation",
  "app.wait",
  "app.sample",
  "app.subscribe",
  "app.unsubscribe",
]
const CONTROLLING: ReadonlyArray<Method> = ["app.reset", "app.advanceTime", "session.shutdown"]

test("observing is open to every policy", () => {
  for (const policy of [control, observe, onlyAdd]) {
    for (const method of OBSERVING) {
      expect(permitted(policy, method)).toBe(true)
    }
  }
})

test("resets, virtual time and shutdown need full control", () => {
  for (const method of CONTROLLING) {
    expect(permitted(control, method)).toBe(true)
    expect(permitted(observe, method)).toBe(false)
    expect(permitted(onlyAdd, method)).toBe(false)
  }
})

test("an allowlist dispatches and cancels only the actions it names", () => {
  expect(permitted(onlyAdd, "app.dispatch", { action: "Add" })).toBe(true)
  expect(permitted(onlyAdd, "app.dispatch", { action: "Reset" })).toBe(false)
  expect(permitted(onlyAdd, "app.dispatch", {})).toBe(false)
  expect(permitted(onlyAdd, "app.cancel", { cancelling: "Add" })).toBe(true)
  expect(permitted(onlyAdd, "app.cancel", { cancelling: "Reset" })).toBe(false)
  expect(permitted(observe, "app.dispatch", { action: "Add" })).toBe(false)
  expect(permitted(observe, "app.cancel", { cancelling: "Add" })).toBe(false)
})

test("a method the check does not know is refused, not allowed", () => {
  expect(permitted(observe, "app.future" as Method)).toBe(false)
  expect(permitted(onlyAdd, "app.future" as Method)).toBe(false)
})

test("an allowlist must name a bounded number of usable action names", () => {
  expect(() => accessPolicy({ kind: "actions", actions: [] })).toThrow()
  expect(() => accessPolicy({ kind: "actions", actions: [""] })).toThrow()
  expect(() => accessPolicy({ kind: "actions", actions: ["x".repeat(257)] })).toThrow()
  const tooMany = Array.from({ length: ACCESS_ACTIONS_MAX + 1 }, (_, index) => `A${index}`)
  expect(() => accessPolicy({ kind: "actions", actions: tooMany })).toThrow()
  expect(accessPolicy({ kind: "actions", actions: ["Add", "Add"] })).toEqual(onlyAdd)
})

test("two policies together allow only what both allow", () => {
  expect(narrowerAccess(control, onlyAdd)).toEqual(onlyAdd)
  expect(narrowerAccess(onlyAdd, observe)).toEqual(observe)
  expect(narrowerAccess({ kind: "actions", actions: ["Add", "Save"] }, onlyAdd)).toEqual(onlyAdd)
  expect(narrowerAccess({ kind: "actions", actions: ["Save"] }, onlyAdd)).toEqual(observe)
})

test("an inspection shows a forbidden action as unavailable, and why", () => {
  const nodeId = "screen/Counter/s-1/1" as NodeId
  const result: InspectResult = {
    protocolVersion: "0.2",
    sessionId: "s-1",
    revision: 1,
    focus: nodeId,
    node: {
      id: nodeId,
      type: "screen",
      name: "Counter",
      revision: 1,
      state: { count: 0 },
      actions: {
        Add: { available: true, inputSchema: {} },
        Reset: { available: false, unavailableReason: "Already zero", inputSchema: {} },
        Save: { available: true, inputSchema: {} },
      },
    },
    ambient: [
      { nodeId, nodeType: "navigation", action: "GoBack", available: true, inputSchema: {} },
    ],
  }
  const shown = restrictInspection(onlyAdd, result)
  expect(shown.node?.actions.Add).toEqual({ available: true, inputSchema: {} })
  // A reason the app gave still stands: it is the more useful one.
  expect(shown.node?.actions.Reset).toMatchObject({ unavailableReason: "Already zero" })
  expect(shown.node?.actions.Save).toMatchObject({
    available: false,
    unavailableReason: "Not permitted on this connection",
  })
  expect(shown.ambient[0]).toMatchObject({ available: false })
  expect(restrictInspection(control, result)).toBe(result)
})

test("a policy from the wire is held to the same bounds", () => {
  const described = (access: unknown) =>
    resultParsers["app.describe"](
      {
        protocolVersion: "0.2",
        app: "a",
        sessionId: "s",
        scenario: "d",
        scenarios: [],
        capabilities: { virtualTime: false },
        access,
      },
      "result",
    )
  expect(described({ kind: "actions", actions: ["Add"] }).access).toEqual(onlyAdd)
  for (const actions of [[], ["x".repeat(257)], Array.from({ length: 257 }, (_, i) => `A${i}`)]) {
    expect(() => described({ kind: "actions", actions })).toThrow()
  }
})
