import { expect, test } from "bun:test"
import {
  ErrorCode,
  type Json,
  NODE_LISTENERS_MAX,
  NODE_STATE_CHARACTERS_MAX,
  NODE_STATE_DEPTH_MAX,
  type RuntimeEvent,
} from "@reflex/protocol"
import { createRuntime, defineStoreNode, standardInput } from "@reflex/runtime/internal"
import Ajv from "ajv/dist/2020.js"
import { createStore, type StoreApi } from "zustand/vanilla"
import { z } from "zod"
const addSchema = z.strictObject({ by: z.int() })

const setup = () => {
  const runtime = createRuntime({ sessionId: "store-test" })
  const store = createStore(() => ({ count: 0, secret: "hidden" }))
  const events: RuntimeEvent[] = []
  runtime.subscribe((event) => events.push(event))
  const node = defineStoreNode({
    name: "Counter",
    store: () => store,
    project: ({ count }) => ({ count }),
    actions: (action) => ({
      Add: action({
        input: standardInput(addSchema),
        handler: ({ by }: z.infer<typeof addSchema>) =>
          store.setState(({ count }) => ({ count: count + by })),
      }),
      Reset: action({
        available: ({ count }) => (count === 0 ? "Already zero" : true),
        handler: () => store.setState({ count: 0 }),
      }),
    }),
  }).mount(runtime)
  return { runtime, store, events, node }
}

test("explicit public projection excludes secrets, detaches and suppresses unchanged writes", async () => {
  const { runtime, store, events, node } = setup()
  const before = node.getSnapshot()
  store.setState({ secret: "other" })
  expect(node.getSnapshot()).toBe(before)
  expect(events.filter((event) => event.type === "state.changed")).toEqual([])
  await node.dispatchRaw("Add", { by: 2 })
  expect(runtime.inspect({ name: "Counter" }).node?.state).toEqual({ count: 2 })
  expect(JSON.stringify(events)).not.toContain("hidden")
  expect(Object.isFrozen(node.getSnapshot())).toBe(true)
  expect(before).toEqual({ count: 0 })
  node.dispose()
  const sequence = runtime.sequence
  store.setState({ count: 99 })
  expect(runtime.sequence).toBe(sequence)
  expect(runtime.inspect({ tree: true }).tree).toEqual([])
  await expect(node.dispatchRaw("Add", { by: 1 })).rejects.toMatchObject({
    code: ErrorCode.NodeNotFound,
  })
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
      expect((await node.dispatchRaw("Add", input)).status).toBe("completed")
    } else {
      await expect(node.dispatchRaw("Add", input)).rejects.toMatchObject({
        code: ErrorCode.InvalidInput,
      })
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
  const node = defineStoreNode({
    name: "Async",
    store: () => createStore(() => 0),
    actions: (action) => ({
      Run: action({
        input,
        handler: () => {
          called = true
        },
      }),
    }),
  }).mount(runtime)
  const sequence = runtime.sequence
  await expect(node.dispatchRaw("Run", "ok")).rejects.toMatchObject({
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
  const node = defineStoreNode({
    name: "Async",
    store: () => createStore(() => 0),
    actions: (action) => ({
      Barrier: action({ handler: () => undefined }),
      Run: action({
        handler: (_, context) => {
          signal = context.signal
          return pending.promise
        },
      }),
    }),
  }).mount(runtime)
  const op = await runtime.dispatch({ action: "Run" })
  await node.dispatchRaw("Barrier") // A later synchronous operation settles while Run remains pending.
  expect(runtime.operation(op.operationId).status).toBe("running")
  pending.resolve()
  expect((await runtime.wait({ operationId: op.operationId })).operation?.status).toBe("completed")
  // A fresh unresolved promise for another registered owner.
  const never = deferred<void>()
  const other = defineStoreNode({
    name: "Other",
    store: () => createStore(() => 0),
    actions: (action) => ({
      Wait: action({
        handler: (_, context) => {
          signal = context.signal
          return never.promise
        },
      }),
    }),
  }).mount(runtime)
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

test("unbranded thrown values and synchronous or asynchronous errors are defects", async () => {
  const runtime = createRuntime({ sessionId: "failures" })
  const node = defineStoreNode({
    name: "Errors",
    store: () => createStore(() => 0),
    actions: (action) => ({
      Declared: action({
        handler: () => {
          throw { _tag: "Rejected", message: "expected" }
        },
      }),
      Sync: action({
        handler: () => {
          throw new Error("bug")
        },
      }),
      Async: action({
        handler: async () => {
          throw new Error("async bug")
        },
      }),
    }),
  }).mount(runtime)
  expect(await node.dispatchRaw("Declared")).toMatchObject({
    status: "failed",
    error: { tag: "Defect", defect: true },
  })
  expect(await node.dispatchRaw("Sync")).toMatchObject({
    status: "failed",
    error: { defect: true },
  })
  expect(await node.dispatchRaw("Async")).toMatchObject({
    status: "failed",
    error: { defect: true },
  })
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
    const runtime = createRuntime({ sessionId: "limits", onBackgroundError: () => undefined })
    const store = createStore<unknown>(() => invalid)
    expect(() =>
      defineStoreNode({
        name: "Invalid",
        store: () => store,
        // Deliberately bypass static JSON checking to exercise publication at runtime.
        project: (s): string => s as string,
        actions: () => ({}),
      }).mount(runtime),
    ).toThrow()
    expect(runtime.sequence).toBe(0)
    store.setState("valid")
    const node = defineStoreNode({
      name: "Valid",
      store: () => store,
      // Deliberately bypass static JSON checking to exercise runtime publication.
      project: (s): string => s as string,
      actions: () => ({}),
    }).mount(runtime)
    const sequence = runtime.sequence
    store.setState(invalid, true)
    expect(node.getSnapshot() as unknown).toBe("valid")
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
  const node = defineStoreNode({
    name: "Redux",
    store: () => store,
    project: (s) => ({ count: s }),
    actions: (action) => ({ Increment: action({ handler: () => store.dispatch() }) }),
  }).mount(runtime)
  await node.dispatchRaw("Increment")
  expect(node.getSnapshot()).toEqual({ count: 1 })
  node.dispose()
  expect(listeners.size).toBe(0)
})

test("projection accessors are rejected without invoking them and invalid writes fail as limits", async () => {
  const runtime = createRuntime({
    sessionId: "public-boundary",
    onBackgroundError: () => undefined,
  })
  let read = false
  const accessor = {
    get token() {
      read = true
      return "secret"
    },
  }
  expect(() =>
    defineStoreNode({
      name: "Getter",
      store: () => createStore(() => 0),
      project: () => accessor,
      actions: () => ({}),
    }).mount(runtime),
  ).toThrow("accessors")
  expect(read).toBe(false)
  const store = createStore<unknown>(() => null)
  const node = defineStoreNode({
    name: "Limits",
    store: () => store,
    // Deliberately bypass static JSON checking to exercise runtime publication.
    project: (s): string => s as string,
    actions: (action) => ({
      Overflow: action({
        handler: () => store.setState("x".repeat(NODE_STATE_CHARACTERS_MAX), true),
      }),
    }),
  }).mount(runtime)
  expect(await node.dispatchRaw("Overflow")).toMatchObject({
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
    const node = defineStoreNode({
      name: "Fits",
      store: () => createStore(() => initial),
      // Deliberately bypass static JSON checking to exercise runtime publication.
      project: (s): string => s as string,
      actions: () => ({}),
    }).mount(runtime)
    expect(node.getSnapshot() as unknown).toEqual(initial)
    node.dispose()
  }
})

test("no-input actions reject payloads before acceptance and listeners are bounded", async () => {
  const { runtime, node } = setup()
  const sequence = runtime.sequence
  // Add changes availability; Reset itself takes no input.
  await node.dispatchRaw("Add", { by: 1 })
  const accepted = runtime.sequence
  await expect(node.dispatchRaw("Reset", { unexpected: true })).rejects.toMatchObject({
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
  const node = defineStoreNode({
    name: "Detached",
    store: () => createStore(() => raw),
    actions: () => ({}),
  }).mount(runtime)
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
    defineStoreNode({
      name: "Array",
      store: () => createStore(() => value),
      project: (state): readonly number[] => state,
      actions: () => ({}),
    }).mount(runtime),
  ).toThrow("named properties")
  expect(encoded).toBe(false)
})

test("state that cannot be published never breaks the application's own store write", async () => {
  const reported: Array<unknown> = []
  const runtime = createRuntime({
    sessionId: "app-write",
    onBackgroundError: (error) => reported.push(error),
  })
  const store = createStore<{ count: number; extra?: unknown }>(() => ({ count: 0 }))
  const node = defineStoreNode({
    name: "Counter",
    store: () => store,
    // Deliberately allow malformed writes to reach runtime publication.
    project: (state) => state as { count: number },
    actions: (action) => ({
      Add: action({ handler: () => store.setState(({ count }) => ({ count: count + 1 })) }),
    }),
  }).mount(runtime)
  // Subscribed after Reflex, as an app's UI usually is.
  let uiNotified = 0
  store.subscribe(() => {
    uiNotified++
  })

  expect(() => store.setState({ extra: () => "not JSON" })).not.toThrow()
  store.setState({ extra: () => "still not JSON" })
  expect(uiNotified).toBe(2)
  expect(node.getSnapshot()).toEqual({ count: 0 })
  expect(reported).toHaveLength(1)

  // An operation that ends with the state unpublishable says so, though its work ran.
  expect(await node.dispatchRaw("Add")).toMatchObject({ status: "failed" })

  store.setState({ extra: undefined, count: 5 }, false)
  store.setState({ count: 5 }, true)
  expect(node.getSnapshot()).toEqual({ count: 5 })
  expect((await node.dispatchRaw("Add")).status).toBe("completed")
  expect(node.getSnapshot()).toEqual({ count: 6 })

  // Recovered, so a later failure is reported again rather than staying silent.
  store.setState({ extra: () => "not JSON again" })
  expect(reported).toHaveLength(2)
  node.dispose()
})

test("a refused input says what is wrong, within a bound", async () => {
  const { node } = setup()
  const refused = await node.dispatchRaw("Add", { by: "3" }).catch((error: unknown) => error)
  expect(refused).toMatchObject({ code: ErrorCode.InvalidInput })
  expect(String(refused)).toContain("by:")
  node.dispose()

  const runtime = createRuntime({ sessionId: "many-issues" })
  const many = defineStoreNode({
    name: "Many",
    store: () => createStore(() => 0),
    actions: (action) => ({
      Run: action({
        input: standardInput(
          {
            "~standard": {
              version: 1,
              vendor: "test",
              validate: () => ({
                issues: Array.from({ length: 1000 }, (_, index) => ({
                  message: "m".repeat(100),
                  path: [{ key: `field${index}` }],
                })),
              }),
            },
          },
          { type: "object" },
        ),
        handler: () => undefined,
      }),
    }),
  }).mount(runtime)
  const bounded = (await many.dispatchRaw("Run", {}).catch((error: unknown) => error)) as Error
  expect(bounded.message).toContain("field0: ")
  expect(bounded.message).not.toContain("field5: ")
  many.dispose()
})

test("cancelled handlers lose store methods before abort listeners and late continuations run", async () => {
  const runtime = createRuntime({ sessionId: "revoked-handler" })
  const store = createStore(() => ({ count: 0 }))
  const barrier = deferred<void>()
  const settled = deferred<void>()
  let abortWrite: unknown
  let lateWrite: unknown
  const node = defineStoreNode({
    name: "Counter",
    store: () => store,
    actions: (action) => ({
      Run: action({
        handler: async (_, { store, signal }) => {
          const write = (store as StoreApi<{ count: number }>).setState
          signal.addEventListener("abort", () => {
            try {
              write({ count: 1 })
            } catch (error) {
              abortWrite = error
            }
          })
          await barrier.promise
          try {
            write({ count: 2 })
          } catch (error) {
            lateWrite = error
          } finally {
            settled.resolve()
          }
        },
      }),
    }),
  }).mount(runtime)
  const operation = await runtime.dispatch({ action: "Run" })
  runtime.cancel(operation.operationId)
  expect(abortWrite).toMatchObject({ code: ErrorCode.SessionClosed })
  barrier.resolve()
  await settled.promise
  expect(lateWrite).toMatchObject({ code: ErrorCode.SessionClosed })
  expect(store.getState()).toEqual({ count: 0 })
  expect(node.getSnapshot()).toEqual({ count: 0 })
  expect((await runtime.wait({ operationId: operation.operationId })).operation?.status).toBe(
    "cancelled",
  )
  node.dispose()
})

test("disposing a store generation revokes handler access while a fresh store stays independent", async () => {
  const runtime = createRuntime({ sessionId: "revoked-generation" })
  const store = createStore(() => ({ count: 0 }))
  const barrier = deferred<void>()
  const settled = deferred<void>()
  let lateWrite: unknown
  const node = defineStoreNode({
    name: "Counter",
    store: () => store,
    actions: (action) => ({
      Run: action({
        handler: async (_, { store }) => {
          await barrier.promise
          try {
            ;(store as StoreApi<{ count: number }>).setState({ count: 99 })
          } catch (error) {
            lateWrite = error
          } finally {
            settled.resolve()
          }
        },
      }),
    }),
  }).mount(runtime)
  const operation = await runtime.dispatch({ action: "Run" })
  node.dispose()
  expect((await runtime.wait({ operationId: operation.operationId })).operation?.status).toBe(
    "cancelled",
  )
  const nextStore = createStore(() => ({ count: 5 }))
  const next = defineStoreNode({
    name: "Counter",
    store: () => nextStore,
    actions: () => ({}),
  }).mount(runtime)
  const sequence = runtime.sequence
  barrier.resolve()
  await settled.promise
  expect(lateWrite).toMatchObject({ code: ErrorCode.SessionClosed })
  expect(store.getState()).toEqual({ count: 0 })
  expect(nextStore.getState()).toEqual({ count: 5 })
  expect(next.getSnapshot()).toEqual({ count: 5 })
  expect(runtime.sequence).toBe(sequence)
  expect((await runtime.wait({ operationId: operation.operationId })).operation?.status).toBe(
    "cancelled",
  )
  next.dispose()
})

test("guarded handlers preserve frozen class stores and stable extracted methods", async () => {
  class CounterStore {
    #count = 0
    #listeners = new Set<() => void>()
    getState() {
      return { count: this.#count }
    }
    subscribe(listener: () => void) {
      this.#listeners.add(listener)
      return () => {
        this.#listeners.delete(listener)
      }
    }
    increment() {
      this.#count++
      for (const listener of this.#listeners) {
        listener()
      }
    }
  }
  const runtime = createRuntime({ sessionId: "class-store" })
  const store = Object.freeze(new CounterStore())
  const node = defineStoreNode({
    name: "Counter",
    store: () => store,
    actions: (action) => ({
      Increment: action({
        handler: (_, { store }) => {
          const counter = store as CounterStore
          expect(counter.increment).toBe(counter.increment)
          const increment = counter.increment
          increment()
          expect(counter.getState()).toEqual({ count: 1 })
        },
      }),
    }),
  }).mount(runtime)
  expect((await node.dispatchRaw("Increment")).status).toBe("completed")
  expect(node.getSnapshot()).toEqual({ count: 1 })
  node.dispose()
})
