import { expect, test } from "bun:test"
import {
  ErrorCode,
  type Json,
  NODES_MAX,
  ProtocolError,
  RETAINED_ERROR_DATA_CHARACTERS_MAX,
  RETAINED_EVENT_CHARACTER_COUNT_MAX,
  RETAINED_EVENTS_MAX,
  RETAINED_OPERATIONS_MAX,
  RUNNING_OPERATIONS_MAX,
  type RuntimeEvent,
  SUBSCRIBERS_MAX,
  toNodeId,
  toOperationId,
  WAITS_MAX,
} from "@reflex/protocol"
import {
  createRuntime,
  matches,
  type NodeAdapter,
  type Runtime,
  type Timers,
  withDeadline,
} from "@reflex/runtime/internal"
import { EventLog } from "../src/event-log.ts"

const available = { available: true, inputSchema: {} } as const

/** A minimal node whose operations finish when the test says so. */
const nodeOn = (runtime: Runtime, name: string, state: Json = {}) => {
  const listeners = new Set<() => void>()
  const finishes: Array<() => void> = []
  let current = state
  const adapter: NodeAdapter = {
    id: runtime.nextId("service", name),
    type: "service",
    name,
    snapshot: () => current,
    describeActions: () => ({ Go: available }),
    prepare: () => () => ({
      done: new Promise((resolve) => finishes.push(() => resolve({ status: "completed" }))),
      cancel: () => undefined,
    }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    adapter,
    finishes,
    setState: (next: Json) => {
      current = next
      for (const listener of listeners) {
        listener()
      }
    },
  }
}

const setup = () => {
  const runtime = createRuntime({ sessionId: "test" })
  const node = nodeOn(runtime, "Only")
  runtime.register(node.adapter)
  return { runtime, ...node }
}

const manualTimers = () => {
  const pending: Array<() => void> = []
  const timers: Timers = {
    setTimeout: (callback) => pending.push(callback),
    clearTimeout: () => undefined,
  }
  const fire = () => {
    for (const callback of pending.splice(0)) {
      callback()
    }
  }
  return { timers, fire }
}

test("matches compares arrays in full and objects as subsets", () => {
  expect(matches({ a: 1, b: 2 }, { a: 1 })).toBe(true)
  expect(matches({ a: 1 }, { a: 2 })).toBe(false)
  expect(matches({ a: [1, { b: 2, c: 3 }] }, { a: [1, { b: 2 }] })).toBe(true)
  expect(matches({ a: [1, 2] }, { a: [1] })).toBe(false)
  expect(matches({ a: 1 }, { a: [1] })).toBe(false)
  expect(matches({ a: null }, { a: {} })).toBe(false)
  expect(matches(null, null)).toBe(true)
})

test("matches keeps arrays and objects apart, and ignores inherited keys", () => {
  expect(matches({ a: [1, 2] }, { a: {} })).toBe(false)
  expect(matches({ a: [1, 2] }, { a: { length: 2 } })).toBe(false)
  expect(matches({ a: {} }, { a: [] })).toBe(false)
  expect(matches({}, JSON.parse('{"__proto__":{}}'))).toBe(false)
  expect(matches({}, { toString: Object.prototype.toString })).toBe(false)
})

test("matches handles nesting deeper than a call stack would", () => {
  let actual: Json = 1
  for (let depth = 0; depth < 50_000; depth++) {
    actual = { next: actual }
  }
  expect(matches(actual, actual)).toBe(true)
})

test("an action on two ambient nodes must be disambiguated", async () => {
  const { runtime } = setup()
  runtime.register(nodeOn(runtime, "Other").adapter)
  await expect(runtime.dispatch({ action: "Go" })).rejects.toMatchObject({
    code: ErrorCode.AmbiguousAction,
  })
})

test("names inherited from Object are not actions", async () => {
  const { runtime, adapter } = setup()
  for (const action of ["toString", "constructor", "__proto__"]) {
    await expect(runtime.dispatch({ action, nodeId: adapter.id })).rejects.toMatchObject({
      code: ErrorCode.ActionNotFound,
    })
    await expect(runtime.dispatch({ action })).rejects.toMatchObject({
      code: ErrorCode.ActionNotFound,
    })
  }
})

test("an invocation that rejects is a failed operation, not a stuck one", async () => {
  const runtime = createRuntime({ sessionId: "test" })
  const { adapter } = nodeOn(runtime, "Bad")
  runtime.register({
    ...adapter,
    prepare: () => () => ({
      done: Promise.reject(new Error("broken")),
      cancel: () => undefined,
    }),
  })
  const info = await runtime.dispatch({ action: "Go", await: true })
  expect(info).toMatchObject({ status: "failed", error: { tag: "Defect", defect: true } })
})

test("running operations are capped, and the limit is exact", async () => {
  const { runtime } = setup()
  for (let index = 0; index < RUNNING_OPERATIONS_MAX; index++) {
    await runtime.dispatch({ action: "Go" })
  }
  await expect(runtime.dispatch({ action: "Go" })).rejects.toMatchObject({
    code: ErrorCode.ResourceExhausted,
  })
})

test("settled operations stay within retention, even after a burst", async () => {
  const { runtime, finishes } = setup()
  const burstCount = RETAINED_OPERATIONS_MAX + 100
  const operations = []
  for (let index = 0; index < burstCount; index++) {
    operations.push(await runtime.dispatch({ action: "Go" }))
  }
  for (const finish of finishes) {
    finish()
  }
  await runtime.wait({ idle: true })
  const oldest = operations[0]
  const newest = operations.at(-1)
  expect(() => runtime.operation(oldest?.operationId ?? toOperationId("?"))).toThrow(ProtocolError)
  expect(runtime.operation(newest?.operationId ?? toOperationId("?")).status).toBe("completed")
})

test("an unknown operation rejects rather than throwing", async () => {
  const { runtime } = setup()
  const waiting = runtime.wait({ operationId: toOperationId("op-nope") })
  await expect(waiting).rejects.toMatchObject({ code: ErrorCode.OperationNotFound })
})

test("waits are capped, and an aborted one ends at once", async () => {
  const { timers } = manualTimers()
  const runtime = createRuntime({ sessionId: "test", timers })
  const lifetime = new AbortController()
  const waits = []
  for (let index = 0; index < WAITS_MAX; index++) {
    waits.push(runtime.wait({ focus: "Never" }, { signal: lifetime.signal }).catch((e) => e))
  }
  await expect(runtime.wait({ focus: "Never" })).rejects.toMatchObject({
    code: ErrorCode.ResourceExhausted,
  })
  lifetime.abort()
  expect(await Promise.all(waits)).toSatisfy((results: ReadonlyArray<ProtocolError>) =>
    results.every((error) => error.code === ErrorCode.SessionClosed),
  )
})

test("a timeout comes from the injected timers, with the state it gave up on", async () => {
  const { timers, fire } = manualTimers()
  const runtime = createRuntime({ sessionId: "test", timers })
  const node = nodeOn(runtime, "Only", { count: 1 })
  runtime.register(node.adapter)
  const waiting = runtime
    .wait({ name: "Only", match: { count: 2 } })
    .catch((error: unknown) => error)
  fire()
  expect(await waiting).toMatchObject({
    code: ErrorCode.WaitTimeout,
    data: { state: { count: 1 } },
  })
})

test("a timeout settles even if its state cannot be read", async () => {
  const { timers, fire } = manualTimers()
  const runtime = createRuntime({ sessionId: "test", timers })
  const { adapter } = nodeOn(runtime, "Only", { count: 1 })
  let broken = false
  runtime.register({
    ...adapter,
    snapshot: () => {
      if (broken) {
        throw new Error("unreadable")
      }
      return adapter.snapshot()
    },
  })
  const waiting = runtime
    .wait({ name: "Only", match: { count: 2 } })
    .catch((error: unknown) => error)
  broken = true
  fire()
  expect(await waiting).toMatchObject({ code: ErrorCode.WaitTimeout })
})

test("nodes are capped", () => {
  const runtime = createRuntime({ sessionId: "test" })
  for (let index = 0; index < NODES_MAX; index++) {
    runtime.register(nodeOn(runtime, "Node").adapter)
  }
  expect(() => runtime.register(nodeOn(runtime, "Node").adapter)).toThrow(ProtocolError)
})

test("a cursor from another session always resynchronizes", () => {
  const { runtime, setState } = setup()
  setState({ a: 1 })
  const seen: Array<RuntimeEvent["type"]> = []
  runtime.subscribe((event) => seen.push(event.type), {
    since: { sessionId: "another", sequence: 0 },
  })
  expect(seen).toEqual(["resync.required"])
})

test("a cursor is exact at the edge of what is retained", () => {
  const { runtime, setState } = setup()
  for (let index = 0; index < RETAINED_EVENTS_MAX + 10; index++) {
    setState({ index })
  }
  const { sequence, sessionId } = runtime
  const oldestRetained = sequence - RETAINED_EVENTS_MAX + 1
  const replayFrom = (since: number) => {
    const events: Array<RuntimeEvent> = []
    runtime.subscribe((event) => events.push(event), { since: { sessionId, sequence: since } })()
    return events
  }
  expect(replayFrom(oldestRetained - 1)).toHaveLength(RETAINED_EVENTS_MAX)
  expect(replayFrom(oldestRetained - 2).map((event) => event.type)).toEqual(["resync.required"])
  expect(replayFrom(sequence)).toEqual([])
  expect(replayFrom(sequence + 1).map((event) => event.type)).toEqual(["resync.required"])
})

test("the log evicts by size as well as count, but keeps the newest event", () => {
  const log = new EventLog()
  const event = (sequence: number, size: number): RuntimeEvent => ({
    type: "state.changed",
    sessionId: "test",
    sequence,
    revision: sequence,
    nodeId: toNodeId("n"),
    state: "x".repeat(size),
  })
  const retained = () => {
    const entries: unknown = Reflect.get(log, "entries")
    return Array.isArray(entries) ? entries.filter(Boolean).length : 0
  }
  log.append(event(1, 10))
  log.append(event(2, 12 * 1024 * 1024))
  log.append(event(3, 12 * 1024 * 1024))
  expect(log.after({ sequence: 0, latestSequence: 3 })).toBeNull()
  expect(log.after({ sequence: 2, latestSequence: 3 })?.map(({ sequence }) => sequence)).toEqual([
    3,
  ])
  // Eviction must release the event, not merely stop counting it.
  expect(retained()).toBe(1)
})

test("an event over the whole budget is not retained at all", () => {
  const log = new EventLog()
  const oversized: RuntimeEvent = {
    type: "state.changed",
    sessionId: "test",
    sequence: 1,
    revision: 1,
    nodeId: toNodeId("n"),
    state: "x".repeat(RETAINED_EVENT_CHARACTER_COUNT_MAX),
  }
  log.append(oversized)
  expect(log.after({ sequence: 0, latestSequence: 1 })).toBeNull()
})

test("an observer that throws cannot fail application work", async () => {
  const reported: Array<unknown> = []
  const runtime = createRuntime({ sessionId: "test", onBackgroundError: (e) => reported.push(e) })
  const node = nodeOn(runtime, "Only")
  runtime.register(node.adapter)
  const seenByLaterListener: Array<string> = []
  runtime.subscribe(() => {
    throw new Error("observer failed")
  })
  runtime.subscribe((event) => seenByLaterListener.push(event.type))
  const operation = await runtime.dispatch({ action: "Go" })
  for (const finish of node.finishes) {
    finish()
  }
  await runtime.wait({ operationId: operation.operationId })
  expect(seenByLaterListener).toEqual(["operation.started", "operation.finished"])
  expect(reported.length).toBeGreaterThan(0)
})

test("sample only serves actions the node has", async () => {
  const { runtime, adapter } = setup()
  for (const action of ["Nope", "constructor", "__proto__"]) {
    await expect(runtime.sample({ action, nodeId: adapter.id })).rejects.toMatchObject({
      code: ErrorCode.ActionNotFound,
    })
  }
})

test("an awaited dispatch ends with the session, even if its work never does", async () => {
  const { runtime } = setup()
  const waiting = runtime.dispatch({ action: "Go", await: true }).catch((error: unknown) => error)
  await Promise.resolve()
  runtime.close()
  expect(await waiting).toMatchObject({ code: ErrorCode.SessionClosed })
})

test("an awaited dispatch ends with its connection", async () => {
  const { runtime } = setup()
  const lifetime = new AbortController()
  const waiting = runtime
    .dispatch({ action: "Go", await: true }, { signal: lifetime.signal })
    .catch((error: unknown) => error)
  await Promise.resolve()
  lifetime.abort()
  expect(await waiting).toMatchObject({ code: ErrorCode.SessionClosed })
})

test("operation ids belong to their session", async () => {
  const first = setup()
  const second = createRuntime({ sessionId: "other" })
  second.register(nodeOn(second, "Only").adapter)
  const { operationId } = await first.runtime.dispatch({ action: "Go" })
  expect(() => second.operation(operationId)).toThrow(ProtocolError)
  expect(() => second.cancel(operationId)).toThrow(ProtocolError)
})

test("a settled operation does not keep oversized error data", async () => {
  const runtime = createRuntime({ sessionId: "test" })
  const { adapter } = nodeOn(runtime, "Bad")
  const data = "x".repeat(RETAINED_ERROR_DATA_CHARACTERS_MAX + 1)
  runtime.register({
    ...adapter,
    prepare: () => () => ({
      done: Promise.resolve({
        status: "failed",
        error: { tag: "Big", message: "m", defect: false, data },
      }),
      cancel: () => undefined,
    }),
  })
  const { operationId } = await runtime.dispatch({ action: "Go" })
  await runtime.wait({ idle: true })
  const settled = runtime.operation(operationId)
  expect(settled).toMatchObject({ status: "failed", error: { tag: "Big" } })
  expect(JSON.stringify(settled)).not.toContain(data)
})

test("subscribers are capped", () => {
  const { runtime } = setup()
  for (let index = 0; index < SUBSCRIBERS_MAX; index++) {
    runtime.subscribe(() => undefined)
  }
  expect(() => runtime.subscribe(() => undefined)).toThrow(ProtocolError)
})

test("events out of order are a programmer error", () => {
  const log = new EventLog()
  const event = (sequence: number): RuntimeEvent => ({
    type: "resync.required",
    sessionId: "test",
    sequence,
    revision: 0,
  })
  log.append(event(2))
  expect(() => log.append(event(2))).toThrow("sequence order")
})

test("an event caused by an observer waits its turn", () => {
  const { runtime, setState } = setup()
  const order: Array<number> = []
  let nested = false
  runtime.subscribe(() => {
    if (!nested) {
      nested = true
      setState({ second: true })
    }
  })
  runtime.subscribe((event) => order.push(event.sequence))
  setState({ first: true })
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(order).toHaveLength(2)
})

test("observers see an operation start before its effects", async () => {
  const runtime = createRuntime({ sessionId: "test" })
  const node = nodeOn(runtime, "Only")
  runtime.register({
    ...node.adapter,
    prepare: () => () => {
      node.setState({ changed: true })
      return { done: Promise.resolve({ status: "completed" }), cancel: () => undefined }
    },
  })
  const types: Array<string> = []
  runtime.subscribe((event) => types.push(event.type))
  await runtime.dispatch({ action: "Go" })
  expect(types.slice(0, 2)).toEqual(["operation.started", "state.changed"])
})

test("input is refused before an operation is reported", async () => {
  const runtime = createRuntime({ sessionId: "test" })
  const { adapter } = nodeOn(runtime, "Only")
  runtime.register({
    ...adapter,
    prepare: () => {
      throw new ProtocolError(ErrorCode.InvalidInput, "no")
    },
  })
  const types: Array<string> = []
  runtime.subscribe((event) => types.push(event.type))
  await expect(runtime.dispatch({ action: "Go" })).rejects.toMatchObject({
    code: ErrorCode.InvalidInput,
  })
  expect(types).toEqual([])
})

test("an awaited dispatch is refused before it runs, not after", async () => {
  const { timers } = manualTimers()
  const runtime = createRuntime({ sessionId: "test", timers })
  let launchCount = 0
  const { adapter } = nodeOn(runtime, "Only")
  runtime.register({
    ...adapter,
    prepare: () => () => {
      launchCount++
      return { done: new Promise(() => undefined), cancel: () => undefined }
    },
  })
  for (let index = 0; index < WAITS_MAX; index++) {
    runtime.wait({ focus: "Never" }).catch(() => undefined)
  }
  await Promise.resolve()
  await expect(runtime.dispatch({ action: "Go", await: true })).rejects.toMatchObject({
    code: ErrorCode.ResourceExhausted,
  })
  expect(launchCount).toBe(0)
})

test("an awaited dispatch past its wait returns the running operation", async () => {
  const { timers, fire } = manualTimers()
  const runtime = createRuntime({ sessionId: "test", timers })
  runtime.register(nodeOn(runtime, "Only").adapter)
  const waiting = runtime.dispatch({ action: "Go", await: true })
  await Promise.resolve()
  fire()
  expect(await waiting).toMatchObject({ status: "running" })
})

test("a name two nodes share is refused, not guessed at", async () => {
  const runtime = createRuntime({ sessionId: "test" })
  runtime.register(nodeOn(runtime, "Twin").adapter)
  runtime.register(nodeOn(runtime, "Twin").adapter)
  expect(() => runtime.inspect({ name: "Twin" })).toThrow(ProtocolError)
  await expect(runtime.wait({ name: "Twin" })).rejects.toMatchObject({
    code: ErrorCode.AmbiguousName,
  })
})

test("an announced operation already exists for whoever hears of it", async () => {
  const { runtime } = setup()
  const looked: Array<string> = []
  runtime.subscribe((event) => {
    if (event.type === "operation.started") {
      looked.push(runtime.operation(event.operation.operationId).status)
    }
  })
  await runtime.dispatch({ action: "Go" })
  expect(looked).toEqual(["running"])
})

test("an operation can be cancelled from its own announcement", async () => {
  const runtime = createRuntime({ sessionId: "test" })
  const { adapter } = nodeOn(runtime, "Only")
  let cancelCount = 0
  runtime.register({
    ...adapter,
    prepare: () => () => ({
      done: new Promise(() => undefined),
      cancel: () => {
        cancelCount++
      },
    }),
  })
  runtime.subscribe((event) => {
    if (event.type === "operation.started") {
      runtime.cancel(event.operation.operationId)
    }
  })
  await runtime.dispatch({ action: "Go" })
  expect(cancelCount).toBe(1)
})

test("idle is not reached by an operation's own synchronous effects", async () => {
  const runtime = createRuntime({ sessionId: "test" })
  const node = nodeOn(runtime, "Only")
  runtime.register({
    ...node.adapter,
    prepare: () => () => {
      node.setState({ step: 1 })
      return { done: new Promise(() => undefined), cancel: () => undefined }
    },
  })
  let settled = false
  runtime
    .wait({ name: "Only", match: { step: 1 }, idle: true, timeoutMs: 60_000 })
    .then(() => {
      settled = true
    })
    .catch(() => undefined)
  await Promise.resolve()
  await runtime.dispatch({ action: "Go" })
  await Promise.resolve()
  expect(settled).toBe(false)
  runtime.close()
})

test("a launch that throws still ends the operation it announced", async () => {
  const runtime = createRuntime({ sessionId: "test" })
  const { adapter } = nodeOn(runtime, "Only")
  runtime.register({
    ...adapter,
    prepare: () => () => {
      throw new Error("launch failed")
    },
  })
  const events: Array<RuntimeEvent> = []
  runtime.subscribe((event) => events.push(event))
  await expect(runtime.dispatch({ action: "Go" })).rejects.toThrow("launch failed")
  expect(events.map(({ type }) => type)).toEqual(["operation.started", "operation.finished"])
  await runtime.wait({ idle: true })
})

test("a deadline that was met leaves no timer behind", async () => {
  let cleared = 0
  const timers: Timers = {
    setTimeout: () => "handle",
    clearTimeout: () => {
      cleared++
    },
  }
  const work = Promise.resolve(1)
  const overdue = () => new Error("overdue")
  expect(await withDeadline(work, { timeoutMs: 1, timers, overdue })).toBe(1)
  expect(cleared).toBe(1)
})

test("direct waits refuse oversized names and focus before retaining them", async () => {
  const { runtime } = setup()
  try {
    for (const params of [{ name: "x".repeat(257) }, { focus: "x".repeat(257) }]) {
      await expect(runtime.wait({ ...params, timeoutMs: 0 })).rejects.toMatchObject({
        code: ErrorCode.ResourceExhausted,
      })
    }
  } finally {
    runtime.close()
  }
})

test("event log compaction bounds slots and preserves replay through repeated cycles", () => {
  const log = new EventLog()
  const latestSequence = RETAINED_EVENTS_MAX * 5
  for (let sequence = 1; sequence <= latestSequence; sequence++) {
    log.append({ type: "resync.required", sessionId: "compact", revision: sequence, sequence })
    // Slots, not just live events, must stay bounded over a long session.
    const slots: unknown = Reflect.get(log, "entries")
    expect(Array.isArray(slots) ? slots.length : Infinity).toBeLessThan(RETAINED_EVENTS_MAX * 2)
  }
  const sequence = latestSequence - RETAINED_EVENTS_MAX
  expect(log.after({ sequence, latestSequence })?.map((event) => event.sequence)).toEqual(
    Array.from({ length: RETAINED_EVENTS_MAX }, (_, index) => sequence + index + 1),
  )
  expect(log.after({ sequence: sequence - 1, latestSequence })).toBeNull()
  expect(log.after({ sequence: latestSequence, latestSequence })).toEqual([])
})
