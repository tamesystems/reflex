import { expect, test } from "bun:test"
import {
  ADVANCE_TIME_MS_MAX,
  boundedText,
  ERROR_TEXT_CHARACTERS_MAX,
  ErrorCode,
  HELD_EVENT_CHARACTERS_MAX,
  JSON_DEPTH_MAX,
  json,
  measureJson,
  operationInfo,
  paramParsers,
  parseServerMessage,
  resultParsers,
  runtimeEvent,
  WAIT_TIMEOUT_MS_MAX,
  WRITE_QUEUE_BYTES_MAX,
} from "@reflex/protocol"

const refuses = (parse: () => unknown) => {
  let thrown: unknown
  try {
    parse()
  } catch (error: unknown) {
    thrown = error
  }
  expect(thrown).toMatchObject({ code: ErrorCode.InvalidParams })
}

test("every method has a parser for its params and its result", () => {
  expect(Object.keys(paramParsers).toSorted()).toEqual(Object.keys(resultParsers).toSorted())
})

test("options must have their declared types, not merely be truthy", () => {
  const { "app.inspect": inspect, "app.wait": wait, "app.dispatch": dispatch } = paramParsers
  refuses(() => inspect({ tree: "yes" }, "params"))
  refuses(() => wait({ idle: "yes" }, "params"))
  refuses(() => dispatch({ action: "A", await: "yes" }, "params"))
  refuses(() => dispatch({ action: "" }, "params"))
  refuses(() => dispatch({}, "params"))
  refuses(() => dispatch({ action: "A", typo: true }, "params"))
})

test("numbers are checked at both ends of their range", () => {
  const wait = paramParsers["app.wait"]
  expect(wait({ timeoutMs: 0 }, "params")).toEqual({ timeoutMs: 0 })
  expect(wait({ timeoutMs: WAIT_TIMEOUT_MS_MAX }, "params")).toEqual({
    timeoutMs: WAIT_TIMEOUT_MS_MAX,
  })
  for (const timeoutMs of [-1, WAIT_TIMEOUT_MS_MAX + 1, 1.5, "1", Number.NaN, 3e9]) {
    refuses(() => wait({ timeoutMs }, "params"))
  }
  const advance = paramParsers["app.advanceTime"]
  expect(advance({ durationMs: ADVANCE_TIME_MS_MAX }, "params")).toBeDefined()
  refuses(() => advance({ durationMs: ADVANCE_TIME_MS_MAX + 1 }, "params"))
  refuses(() => advance({ durationMs: -1 }, "params"))
  refuses(() => paramParsers["app.sample"]({ action: "A", seed: 1.5 }, "params"))
  refuses(() => paramParsers["app.dispatch"]({ action: "A", expectedRevision: -1 }, "params"))
})

test("a target is a handle or a name, not both", () => {
  refuses(() => paramParsers["app.inspect"]({ nodeId: "a", name: "b" }, "params"))
  refuses(() => paramParsers["app.wait"]({ nodeId: "a", name: "b" }, "params"))
})

test("a cursor needs both of its fields", () => {
  const subscribe = paramParsers["app.subscribe"]
  refuses(() => subscribe({ since: 5 }, "params"))
  refuses(() => subscribe({ since: { sequence: 5 } }, "params"))
  expect(subscribe({ since: { sessionId: "s", sequence: 5 } }, "params")).toBeDefined()
})

const nested = (depth: number): unknown => {
  let value: unknown = 1
  for (let index = 1; index < depth; index++) {
    value = [value]
  }
  return value
}

test("JSON is limited in depth, exactly, without recursing", () => {
  expect(json(nested(JSON_DEPTH_MAX), "value")).toBeDefined()
  refuses(() => json(nested(JSON_DEPTH_MAX + 1), "value"))
  refuses(() => json(nested(1_000_000), "value"))
  refuses(() => json(undefined, "value"))
  refuses(() => json({ a: () => 1 }, "value"))
})

test("JSON means what survives being serialized", () => {
  refuses(() => json(JSON.parse('{"value":1e400}'), "value"))
  refuses(() => json(Number.NaN, "value"))
  refuses(() => json(new Map([["a", 1]]), "value"))
  refuses(() => json(new Date(0), "value"))
  expect(json({ a: [1, "two", null, true] }, "value")).toBeDefined()
})

test("contradictory operations cannot be parsed", () => {
  const base = { operationId: "o", nodeId: "n", action: "A" }
  expect(operationInfo({ ...base, status: "running" }, "op")).toBeDefined()
  refuses(() => operationInfo({ ...base, status: "failed" }, "op"))
  refuses(() =>
    operationInfo(
      { ...base, status: "running", error: { tag: "t", message: "m", defect: true } },
      "op",
    ),
  )
  refuses(() => operationInfo({ ...base, status: "unknown" }, "op"))
})

test("events are parsed by their type", () => {
  const base = { sessionId: "s", sequence: 1, revision: 1 }
  expect(runtimeEvent({ ...base, type: "resync.required" }, "event")).toBeDefined()
  refuses(() => runtimeEvent({ ...base, type: "node.added", nodeId: "n" }, "event"))
  refuses(() => runtimeEvent({ ...base, type: "made.up" }, "event"))
  refuses(() => runtimeEvent(null, "event"))
})

test("operation events carry the statuses their names say", () => {
  const base = { sessionId: "s", sequence: 1, revision: 1 }
  const operation = { operationId: "o", nodeId: "n", action: "A" }
  const running = { ...operation, status: "running" }
  const completed = { ...operation, status: "completed" }
  const started = { ...base, type: "operation.started" }
  const finished = { ...base, type: "operation.finished" }
  expect(runtimeEvent({ ...started, operation: running }, "event")).toBeDefined()
  expect(runtimeEvent({ ...finished, operation: completed }, "event")).toBeDefined()
  refuses(() => runtimeEvent({ ...started, operation: completed }, "event"))
  refuses(() => runtimeEvent({ ...finished, operation: running }, "event"))
})

test("server messages must have a valid envelope", () => {
  expect(parseServerMessage({ jsonrpc: "2.0", id: 1, result: 5 })).toEqual({
    kind: "result",
    id: 1,
    result: 5,
  })
  expect(
    parseServerMessage({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "m" } }),
  ).toMatchObject({ kind: "failure", id: 1 })
  for (const message of [null, 5, [], {}, { jsonrpc: "1.0", id: 1, result: 1 }]) {
    refuses(() => parseServerMessage(message))
  }
  refuses(() => parseServerMessage({ jsonrpc: "2.0", method: "other", params: {} }))
})

test("events held for replies fit the write queue at any encoding", () => {
  expect(HELD_EVENT_CHARACTERS_MAX * 3).toBeLessThanOrEqual(WRITE_QUEUE_BYTES_MAX)
})

test("what must render too large is found at the limit, without rendering", () => {
  // A container or scalar counts for one, a string and a key for their lengths.
  expect(measureJson({ k: "xx" }, 4)).toBe("fits")
  expect(measureJson({ k: "xxx" }, 4)).toBe("too-large")
  expect(measureJson([1, 2, 3], 4)).toBe("fits")
  expect(measureJson([1, 2, 3, 4], 4)).toBe("too-large")
})

test("what cannot be sent is told apart from what is too large", () => {
  expect(measureJson({ a: undefined }, 100)).toBe("not-json")
  expect(measureJson(new Map(), 100)).toBe("not-json")
  expect(measureJson(Number.NaN, 100)).toBe("not-json")
  expect(measureJson(nested(JSON_DEPTH_MAX), 1000)).toBe("fits")
  expect(measureJson(nested(JSON_DEPTH_MAX + 1), 1000)).toBe("too-deep")
})

test("depth means the same to measuring as to parsing, at the boundary", () => {
  const nestedAround = (leaf: unknown, depth: number): unknown => {
    let value = leaf
    for (let index = 1; index < depth; index++) {
      value = [value]
    }
    return value
  }
  for (const leaf of [1, [], {}]) {
    expect(measureJson(nestedAround(leaf, JSON_DEPTH_MAX), 1000)).toBe("fits")
    expect(json(nestedAround(leaf, JSON_DEPTH_MAX), "value")).toBeDefined()
    expect(measureJson(nestedAround(leaf, JSON_DEPTH_MAX + 1), 1000)).toBe("too-deep")
    refuses(() => json(nestedAround(leaf, JSON_DEPTH_MAX + 1), "value"))
  }
})

test("a sparse array is not taken for a small one", () => {
  expect(measureJson(new Array(1_000_000), 4)).toBe("not-json")
})

test("a wide container is read no further than the limit", () => {
  let readCount = 0
  const counted = new Proxy(
    Array.from({ length: 10_000 }, () => 0),
    {
      get: (target, key, receiver) => {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          readCount++
        }
        return Reflect.get(target, key, receiver)
      },
    },
  )
  expect(measureJson(counted, 4)).toBe("too-large")
  expect(readCount).toBeLessThan(10)
  const wide = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`k${index}`, 0]))
  let propertyReadCount = 0
  const countedObject = new Proxy(wide, {
    get: (target, key, receiver) => {
      propertyReadCount++
      return Reflect.get(target, key, receiver)
    },
  })
  expect(measureJson(countedObject, 4)).toBe("too-large")
  expect(propertyReadCount).toBeLessThan(10)
})

test("a small graph that renders enormous stops at the limit, not after visiting it all", () => {
  let shared: unknown = "x".repeat(1024)
  for (let level = 0; level < 40; level++) {
    shared = [shared, shared]
  }
  const startMs = performance.now()
  expect(measureJson(shared, 1_000_000)).toBe("too-large")
  expect(performance.now() - startMs).toBeLessThan(1_000)
})

test("error text is bounded, and untouched when short", () => {
  expect(boundedText("short")).toBe("short")
  const text = "x".repeat(ERROR_TEXT_CHARACTERS_MAX)
  expect(boundedText(text)).toBe(text)
  expect(boundedText(`${text}y`)).toHaveLength(ERROR_TEXT_CHARACTERS_MAX + 1)
})

test("wait names and focus are bounded before retention", () => {
  const wait = paramParsers["app.wait"]
  for (const field of ["name", "focus"]) {
    expect(wait({ [field]: "x".repeat(256) }, "params")).toBeDefined()
    refuses(() => wait({ [field]: "x".repeat(257) }, "params"))
    refuses(() => wait({ [field]: "" }, "params"))
  }
})
