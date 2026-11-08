import { expect, test } from "bun:test"
import {
  ErrorCode,
  type Json,
  NODE_LISTENERS_MAX,
  NODE_STATE_CHARACTERS_MAX,
  NODE_STATE_DEPTH_MAX,
  type RuntimeEvent,
} from "@reflex/protocol"
import { createRuntime, mountStore, standardInput, StoreFailure } from "@reflex/runtime"
import Ajv from "ajv/dist/2020.js"
import { createStore } from "zustand/vanilla"
import { z } from "zod"
import { addInput, addSchema } from "../../../examples/plain/src/app.ts"

const setup = () => {
  const runtime = createRuntime({ sessionId: "store-test" })
  const store = createStore(() => ({ count: 0, secret: "hidden" }))
  const events: RuntimeEvent[] = []
  runtime.subscribe((event) => events.push(event))
  const node = mountStore(runtime, {
    name: "Counter",
    store,
    project: ({ count }) => ({ count }),
    actions: {
      Add: {
        input: addInput,
        handler: ({ by }: z.infer<typeof addSchema>) =>
          store.setState(({ count }) => ({ count: count + by })),
      },
      Reset: {
        available: ({ count }) => (count === 0 ? "Already zero" : true),
        handler: () => store.setState({ count: 0 }),
      },
    },
  })
  return { runtime, store, events, node }
}

test("explicit public projection excludes secrets, detaches and suppresses unchanged writes", async () => {
  const { runtime, store, events, node } = setup()
  const before = node.getSnapshot()
  store.setState({ secret: "other" })
  expect(node.getSnapshot()).toBe(before)
  expect(events.filter((event) => event.type === "state.changed")).toEqual([])
  await node.send("Add", { by: 2 })
  expect(runtime.inspect({ name: "Counter" }).node?.state).toEqual({ count: 2 })
  expect(JSON.stringify(events)).not.toContain("hidden")
  expect(Object.isFrozen(node.getSnapshot())).toBe(true)
  expect(before).toEqual({ count: 0 })
  node.dispose()
  const sequence = runtime.sequence
  store.setState({ count: 99 })
  expect(runtime.sequence).toBe(sequence)
  expect(runtime.inspect({ tree: true }).tree).toEqual([])
  await expect(node.send("Add", { by: 1 })).rejects.toMatchObject({ code: ErrorCode.NodeNotFound })
})

test("published input JSON Schema agrees with Standard Schema before acceptance", async () => {
  const { runtime, node } = setup()
  const schema = runtime.inspect({ name: "Counter" }).node?.actions.Add?.inputSchema
  const validate = new Ajv().compile(schema ?? {})
  for (const input of [
    { by: 3 },
    { by: -2 },
    { by: "3" },
    { by: 0.5 },
    {},
    { by: 2, extra: true },
    null,
  ]) {
    const expected = addSchema.safeParse(input).success
    expect(validate(input)).toBe(expected)
    const sequence = runtime.sequence
    if (expected) {
      expect((await node.send("Add", input)).status).toBe("completed")
    } else {
      await expect(node.send("Add", input)).rejects.toMatchObject({ code: ErrorCode.InvalidInput })
      expect(runtime.sequence).toBe(sequence)
    }
  }
  node.dispose()
})

test("async Standard Schema is explicitly refused without starting work or leaking rejection", async () => {
  const runtime = createRuntime({ sessionId: "async-validator" })
  let called = false
  const input = standardInput(
    z.string().refine(async () => true),
    { type: "string" },
  )
  const node = mountStore(runtime, {
    name: "Async",
    store: createStore(() => 0),
    project: (s) => s,
    actions: {
      Run: {
        input,
        handler: () => {
          called = true
        },
      },
    },
  })
  const sequence = runtime.sequence
  await expect(node.send("Run", "ok")).rejects.toMatchObject({
    code: ErrorCode.InvalidInput,
    message: expect.stringContaining("Async Standard Schema"),
  })
  expect(called).toBe(false)
  expect(runtime.sequence).toBe(sequence)
  node.dispose()
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test("promise work completes only after settlement; cancellation and disposal abort owned work", async () => {
  const runtime = createRuntime({ sessionId: "promises" })
  const pending = deferred<void>()
  let signal: AbortSignal | undefined
  const node = mountStore(runtime, {
    name: "Async",
    store: createStore(() => 0),
    project: (s) => s,
    actions: {
      Barrier: { handler: () => undefined },
      Run: {
        handler: (_, context) => {
          signal = context.signal
          return pending.promise
        },
      },
    },
  })
  const op = await runtime.dispatch({ action: "Run" })
  await node.send("Barrier") // A later synchronous operation settles while Run remains pending.
  expect(runtime.operation(op.operationId).status).toBe("running")
  pending.resolve()
  expect((await runtime.wait({ operationId: op.operationId })).operation?.status).toBe("completed")
  // A fresh unresolved promise for another registered owner.
  const never = deferred<void>()
  const other = mountStore(runtime, {
    name: "Other",
    store: createStore(() => 0),
    project: (s) => s,
    actions: {
      Wait: {
        handler: (_, context) => {
          signal = context.signal
          return never.promise
        },
      },
    },
  })
  const cancelled = await runtime.dispatch({ action: "Wait" })
  runtime.cancel(cancelled.operationId)
  expect(signal?.aborted).toBe(true)
  expect((await runtime.wait({ operationId: cancelled.operationId })).operation?.status).toBe(
    "cancelled",
  )
  const disposed = await runtime.dispatch({ action: "Wait" })
  other.dispose()
  expect(signal?.aborted).toBe(true)
  expect((await runtime.wait({ operationId: disposed.operationId })).operation?.status).toBe(
    "cancelled",
  )
  never.reject(new Error("late rejection is observed"))
  node.dispose()
})

test("declared failures and synchronous or asynchronous defects remain distinct", async () => {
  const runtime = createRuntime({ sessionId: "failures" })
  const node = mountStore(runtime, {
    name: "Errors",
    store: createStore(() => 0),
    project: (s) => s,
    actions: {
      Declared: {
        handler: () => {
          throw new StoreFailure("Rejected", "expected")
        },
      },
      Sync: {
        handler: () => {
          throw new Error("bug")
        },
      },
      Async: {
        handler: async () => {
          throw new Error("async bug")
        },
      },
    },
  })
  expect(await node.send("Declared")).toMatchObject({
    status: "failed",
    error: { tag: "Rejected", defect: false },
  })
  expect(await node.send("Sync")).toMatchObject({ status: "failed", error: { defect: true } })
  expect(await node.send("Async")).toMatchObject({ status: "failed", error: { defect: true } })
  node.dispose()
})

const deep = (depth: number): Json => {
  let value: Json = null
  for (let index = 0; index < depth; index++) {
    value = { child: value }
  }
  return value
}

test("JSON, depth, size and escaped size are checked before registration and each publication", () => {
  for (const invalid of [
    undefined,
    { fn: () => 1 },
    { n: Infinity },
    deep(NODE_STATE_DEPTH_MAX),
    "x".repeat(NODE_STATE_CHARACTERS_MAX),
    "\\".repeat(NODE_STATE_CHARACTERS_MAX * 0.75),
  ]) {
    const runtime = createRuntime({ sessionId: "limits" })
    const store = createStore<unknown>(() => invalid)
    expect(() =>
      mountStore(runtime, { name: "Invalid", store, project: (s) => s, actions: {} }),
    ).toThrow()
    expect(runtime.sequence).toBe(0)
    store.setState("valid")
    const node = mountStore(runtime, { name: "Valid", store, project: (s) => s, actions: {} })
    const sequence = runtime.sequence
    expect(() => store.setState(invalid, true)).toThrow()
    expect(node.getSnapshot()).toBe("valid")
    expect(runtime.sequence).toBe(sequence)
    node.dispose()
  }
})

test("structural Redux-style store needs no Zustand adapter", async () => {
  let count = 0
  const listeners = new Set<() => void>()
  const store = {
    getState: () => count,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispatch: () => {
      count++
      for (const listener of listeners) {
        listener()
      }
    },
  }
  const runtime = createRuntime({ sessionId: "redux" })
  const node = mountStore(runtime, {
    name: "Redux",
    store,
    project: (s) => ({ count: s }),
    actions: { Increment: { handler: () => store.dispatch() } },
  })
  await node.send("Increment")
  expect(node.getSnapshot()).toEqual({ count: 1 })
  node.dispose()
  expect(listeners.size).toBe(0)
})

test("projection accessors are rejected without invoking them and invalid writes fail as limits", async () => {
  const runtime = createRuntime({ sessionId: "public-boundary" })
  let read = false
  const accessor = {
    get token() {
      read = true
      return "secret"
    },
  }
  expect(() =>
    mountStore(runtime, {
      name: "Getter",
      store: createStore(() => 0),
      project: () => accessor,
      actions: {},
    }),
  ).toThrow("accessors")
  expect(read).toBe(false)
  const store = createStore<unknown>(() => null)
  const node = mountStore(runtime, {
    name: "Limits",
    store,
    project: (s) => s,
    actions: {
      Overflow: { handler: () => store.setState("x".repeat(NODE_STATE_CHARACTERS_MAX), true) },
    },
  })
  expect(await node.send("Overflow")).toMatchObject({
    status: "failed",
    error: { tag: "ResourceExhausted", defect: false },
  })
  expect(node.getSnapshot()).toBeNull()
  node.dispose()
})

test("state fits exactly at character and depth boundaries", () => {
  const runtime = createRuntime({ sessionId: "boundary-fits" })
  for (const initial of [
    "x".repeat(NODE_STATE_CHARACTERS_MAX - 2),
    deep(NODE_STATE_DEPTH_MAX - 1),
  ]) {
    const node = mountStore(runtime, {
      name: "Fits",
      store: createStore(() => initial),
      project: (s) => s,
      actions: {},
    })
    expect(node.getSnapshot()).toEqual(initial)
    node.dispose()
  }
})

test("no-input actions reject payloads before acceptance and listeners are bounded", async () => {
  const { runtime, node } = setup()
  const sequence = runtime.sequence
  // Add changes availability; Reset itself takes no input.
  await node.send("Add", { by: 1 })
  const accepted = runtime.sequence
  await expect(node.send("Reset", { unexpected: true })).rejects.toMatchObject({
    code: ErrorCode.InvalidInput,
  })
  expect(runtime.sequence).toBe(accepted)
  expect(accepted).toBeGreaterThan(sequence)
  const cleanups = []
  // Registration already occupies one listener.
  for (let index = 1; index < NODE_LISTENERS_MAX; index++) {
    cleanups.push(node.subscribe(() => undefined))
  }
  expect(() => node.subscribe(() => undefined)).toThrow("Too many node listeners")
  for (const cleanup of cleanups) {
    cleanup()
  }
  node.dispose()
})

test("public snapshots are detached from application-owned nested objects", () => {
  const raw = { nested: { count: 1 } }
  const runtime = createRuntime({ sessionId: "detached" })
  const node = mountStore(runtime, {
    name: "Detached",
    store: createStore(() => raw),
    project: (s) => s,
    actions: {},
  })
  expect(Object.isFrozen(raw.nested)).toBe(false)
  raw.nested.count = 2
  expect(node.getSnapshot()).toEqual({ nested: { count: 1 } })
  node.dispose()
})

test("public arrays cannot execute a custom JSON encoder", () => {
  const runtime = createRuntime({ sessionId: "array-encoder" })
  let encoded = false
  const value = Object.assign([1], {
    toJSON: () => {
      encoded = true
      return "secret"
    },
  })
  expect(() =>
    mountStore(runtime, {
      name: "Array",
      store: createStore(() => value),
      project: (s) => s,
      actions: {},
    }),
  ).toThrow("named properties")
  expect(encoded).toBe(false)
})
