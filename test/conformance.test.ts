/**
 * The reusability claim, tested: one suite, two unrelated backends, and the first again
 * served live as a device serves it. If any needs a special case here, the abstraction
 * has leaked.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { ErrorCode, ProtocolError } from "@reflex/protocol"
import { type AppHost, createRuntime, type NodeAdapter } from "@reflex/runtime"
import { createTestAppPool } from "@reflex/test"
import effectBackend, { COUNTER_APP_MODULE } from "./counter-app.ts"
import { openBridged } from "./live-bridge.ts"

if (process.platform === "win32") {
  setDefaultTimeout(30_000) // Real daemon startup includes Windows ACL verification.
}

const pool = createTestAppPool()
afterEach(pool.disposeAll)

/** The shape of a Zustand vanilla store, with no Effect anywhere. */
const createStore = <S>(initial: S) => {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState: (next: S) => {
      state = next
      for (const listener of listeners) {
        listener()
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

const isByInput = (input: unknown): input is { readonly by?: unknown } =>
  typeof input === "object" && input !== null

const plainBackend: AppHost = {
  name: "counter",
  defaultScenario: "default",
  scenarios: [{ name: "default", virtualTime: false }],
  async start(_, { sessionId }) {
    const runtime = createRuntime({ sessionId })
    const store = createStore({ count: 0 })
    const adapter: NodeAdapter = {
      id: runtime.nextId("screen", "Counter"),
      type: "screen",
      name: "Counter",
      snapshot: store.getState,
      subscribe: store.subscribe,
      actions: () => ({
        Add: {
          available: true,
          inputSchema: {
            type: "object",
            properties: { by: { type: "integer" } },
            required: ["by"],
            additionalProperties: false,
          },
        },
        Reset:
          store.getState().count === 0
            ? {
                available: false,
                unavailableReason: "Already zero",
                inputSchema: { type: "object" },
              }
            : { available: true, inputSchema: { type: "object" } },
      }),
      prepare(action, input) {
        const by = isByInput(input) ? input.by : undefined
        if (action === "Add" && !Number.isInteger(by)) {
          throw new ProtocolError(ErrorCode.InvalidInput, "by must be an integer")
        }
        return () => {
          store.setState({ count: action === "Add" ? store.getState().count + Number(by) : 0 })
          return { done: Promise.resolve({ status: "completed" }), cancel: () => undefined }
        }
      },
    }
    const unregister = runtime.register(adapter)
    runtime.setFocus(adapter.id)
    return { runtime, dispose: async () => unregister() }
  },
}

describe.each([
  ["Effect", () => pool.open(effectBackend)],
  ["plain store", () => pool.open(plainBackend)],
  // Served as a device serves it, over a real WebSocket bridge: what the CLI drives live.
  ["Effect, live through the bridge,", () => pool.openOn(() => openBridged(COUNTER_APP_MODULE))],
] as const)("%s backend", (_, open) => {
  test("inspect exposes state and a JSON Schema per action", async () => {
    const app = await open()
    const { node } = await app.inspect()
    expect(node).toMatchObject({ name: "Counter", type: "screen", state: { count: 0 } })
    expect(node?.actions.Add?.inputSchema).toMatchObject({
      type: "object",
      properties: { by: { type: "integer" } },
      required: ["by"],
    })
  })

  test("dispatch runs the action and subscribers see the change in order", async () => {
    const app = await open()
    await app.do("Add", { by: 2 })
    await app.do("Add", { by: 3 })
    expect(app.state).toEqual({ count: 5 })

    const changes = app.events.flatMap((e) => (e.type === "state.changed" ? [e] : []))
    expect(changes.map((e) => e.state)).toEqual([{ count: 2 }, { count: 5 }])
    const sequences = app.events.map((e) => e.sequence)
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
  })

  test("availability follows state", async () => {
    const app = await open()
    expect(await app.do("Reset").catch((error: unknown) => error)).toMatchObject({
      code: ErrorCode.ActionUnavailable,
    })
    await app.do("Add", { by: 1 })
    expect((await app.do("Reset")).status).toBe("completed")
  })

  test("invalid input and unknown actions are rejected without touching state", async () => {
    const app = await open()
    expect(await app.do("Add", { by: "x" }).catch((error: unknown) => error)).toMatchObject({
      code: ErrorCode.InvalidInput,
    })
    expect(await app.do("Nope").catch((error: unknown) => error)).toMatchObject({
      code: ErrorCode.ActionNotFound,
    })
    await app.inspect()
    expect(app.state).toEqual({ count: 0 })
  })

  test("stale revisions are rejected", async () => {
    const app = await open()
    const { node } = await app.inspect()
    await app.do("Add", { by: 1 })
    expect(
      await app.client
        .request("app.dispatch", {
          action: "Add",
          input: { by: 1 },
          expectedRevision: Number(node?.revision),
        })
        .catch((error: unknown) => error),
    ).toMatchObject({ code: ErrorCode.StaleRevision })
  })

  test("wait resolves on a later state and times out with context", async () => {
    const app = await open()
    const waiting = app.waitFor({ match: { count: 7 } })
    await app.do("Add", { by: 7 })
    await waiting
    expect(
      await app.waitFor({ match: { count: 8 }, timeoutMs: 10 }).catch((error: unknown) => error),
    ).toMatchObject({
      code: ErrorCode.WaitTimeout,
      data: { state: { count: 7 } },
    })
  })
})
