import { afterEach, expect, test } from "bun:test"
import { defineApp, defineCapability } from "@reflex/effect"
import { type ActionsOf, type Capability, NoParams } from "@reflex/effect/advanced"
import {
  defineNavigationFactories,
  mountOwned as mount,
  dispatchDecoded,
  liveNodeOf,
  REDACTED_TEXT,
  redact,
  Registry,
  secretFreeEncoder,
} from "@reflex/effect/internal"
import {
  ErrorCode,
  type Json,
  NODE_LISTENERS_MAX,
  NODE_STATE_CHARACTERS_MAX,
  NODE_STATE_DEPTH_MAX,
  ProtocolError,
  REDACTION_VISITS_MAX,
  REDACTION_VIEW_BYTES_MAX,
  SCHEMA_DEPTH_MAX,
  SCHEMA_NODES_MAX,
  toNodeId,
} from "@reflex/protocol"
import { createTestAppPool, explore, nextTurn, waitUntil } from "@reflex/test"
import * as Chunk from "effect/Chunk"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import app from "../../../examples/inventory/src/app.ts"

const pool = createTestAppPool()
afterEach(pool.disposeAll)

const appFor = <S, A extends ActionsOf<S>, W>(
  capability: Capability<S, A, never, Record<string, never>, W>,
  initial: S,
) =>
  defineApp({
    name: "test",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(capability, initial)
        const registry = yield* Registry
        registry.setFocus(node.id)
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })

test("a handler can pop its own screen without deadlocking", async () => {
  const session = await pool.open(app)
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })
  await session.raw.dispatchRaw("SetQuantity", { quantity: 30 })

  await session.raw.dispatchRaw("SaveAndClose")

  await session.raw.precondition("InventoryList", { _tag: "ready" })
  expect((await session.inspectRaw("InventoryFixture")).state).toMatchObject({
    saved: [{ productId: "product-123", quantity: 30 }],
  })
})

test("a handler that has suspended can still pop its own screen", async () => {
  const session = await pool.open(app, { scenario: "sluggish-network" })
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })
  await session.raw.dispatchRaw("SetQuantity", { quantity: 30 })

  const operation = await session.raw.start("SaveAndClose")
  await session.waitFor({ match: { _tag: "saving" } })
  await session.advanceTime(1000)
  await session.waitFor({ operationId: operation.operationId })

  await session.raw.precondition("InventoryList", { _tag: "ready" })
  expect((await session.inspectRaw("InventoryFixture")).state).toMatchObject({
    saved: [{ productId: "product-123", quantity: 30 }],
  })
  const finished = await session.client.request("app.operation", {
    operationId: operation.operationId,
  })
  expect(finished.status).toBe("completed")
})

test("back-to-back dispatches cannot both pass an availability check", async () => {
  const session = await pool.open(app, { scenario: "slow-network" })
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })

  const results = await Promise.allSettled([session.raw.start("Save"), session.raw.start("Save")])

  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"])
})

test("dispatches in the same tick cannot both pass an availability check", async () => {
  const session = await app.start("slow-network", { sessionId: "same-tick" })
  const { runtime } = session
  await runtime.wait({ idle: true, focus: "InventoryList", match: { _tag: "ready" } })
  await runtime.dispatch({
    action: "OpenProduct",
    input: { productId: "product-123" },
    await: true,
  })
  await runtime.wait({ idle: true, focus: "InventoryDetail", match: { _tag: "editing" } })

  const results = await Promise.allSettled([
    runtime.dispatch({ action: "Save" }),
    runtime.dispatch({ action: "Save" }),
  ])

  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"])
})

const Crashy = defineCapability({
  name: "Crashy",
  state: Schema.Struct({ n: Schema.Int }),
  actions: (action) => ({
    Throw: action({
      handler: (): Effect.Effect<void> => {
        throw new Error("thrown synchronously")
      },
    }),
    Die: action({ handler: () => Effect.die(new Error("died")) }),
    Fail: action({
      error: Schema.Struct({ _tag: Schema.String, message: Schema.String }),
      handler: () => Effect.fail({ _tag: "Nope", message: "declared failure" }),
    }),
  }),
})

test("a throwing handler is a defect on the operation, not a transport error", async () => {
  const session = await pool.open(appFor(Crashy, { n: 0 }))
  const operation = await session.raw.dispatchRaw("Throw")
  expect(operation).toMatchObject({
    status: "failed",
    error: {
      tag: "Defect",
      defect: true,
      message: expect.stringContaining("thrown synchronously"),
    },
  })
})

test("defects and declared failures are distinguished", async () => {
  const session = await pool.open(appFor(Crashy, { n: 0 }))
  expect(await session.raw.dispatchRaw("Die")).toMatchObject({
    status: "failed",
    error: { defect: true },
  })
  expect(await session.raw.dispatchRaw("Fail")).toMatchObject({
    status: "failed",
    error: { tag: "Nope", message: "declared failure", defect: false },
  })
})

test("exploration finds a crash", async () => {
  const OnlyCrash = defineCapability({
    name: "OnlyCrash",
    state: Schema.Struct({ n: Schema.Int }),
    actions: (action) => ({
      Boom: action({ handler: () => Effect.die(new Error("boom")) }),
    }),
  })
  const result = await explore(appFor(OnlyCrash, { n: 0 }), { runCount: 1, stepCount: 3 })
  expect(result.failure?.message).toContain("Boom crashed")
  expect(result.failure?.steps.length).toBe(1)
})

test("exploring finds work a step set off that crashed in the background", async () => {
  const Nav = defineNavigationFactories("test/Haunted", { Home: NoParams, Haunted: NoParams })
  const Haunted = defineCapability({
    name: "Haunted",
    state: Schema.Struct({}),
    onFocus: (): Effect.Effect<void> => {
      throw new Error("focus failed")
    },
    actions: () => ({}),
  })
  const Home = defineCapability({
    name: "Home",
    state: Schema.Struct({}),
    actions: (action) => ({
      Open: action({
        handler: () =>
          Effect.gen(function* () {
            const nav = yield* Nav.Tag
            yield* nav.push("Haunted", {}).pipe(Effect.orDie)
          }),
      }),
    }),
  })
  const host = defineApp({
    name: "haunted",
    defaultScenario: "default",
    root: Nav.layer({
      initial: { route: "Home", params: {} },
      screens: { Home: () => mount(Home, {}), Haunted: () => mount(Haunted, {}) },
    }),
    scenarios: { default: { layer: Layer.empty } },
  })
  const result = await explore(host, { runCount: 5, stepCount: 5 })
  expect(result.failure?.message).toContain("focus failed")
  expect(result.failure?.steps.length).toBeGreaterThan(0)
})

test("a crash on starting is found even with nothing to do afterwards", async () => {
  const Haunted = defineCapability({
    name: "Haunted",
    state: Schema.Struct({}),
    onFocus: (): Effect.Effect<void> => {
      throw new Error("focus failed")
    },
    actions: () => ({}),
  })
  const host = defineApp({
    name: "haunted",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(Haunted, {})
        const registry = yield* Registry
        registry.setFocus(node.id)
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  const result = await explore(host, { runCount: 1, stepCount: 3 })
  expect(result.failure?.message).toContain("focus failed")
})

test("initial state must be valid, and within its limit, to go live", async () => {
  const Counted = defineCapability({
    name: "Counted",
    state: Schema.Struct({ n: Schema.Int }),
    actions: () => ({}),
  })
  await expect(appFor(Counted, { n: 1.5 }).start("default", { sessionId: "s" })).rejects.toThrow()
  const Text = defineCapability({
    name: "Text",
    state: Schema.Struct({ t: Schema.String }),
    actions: () => ({}),
  })
  // What it renders to, around the text, is `{"t":""}`.
  const fits = "x".repeat(NODE_STATE_CHARACTERS_MAX - 8)
  const session = await appFor(Text, { t: fits }).start("default", { sessionId: "s" })
  await session.dispose()
  await expect(
    appFor(Text, { t: `${fits}x` }).start("default", { sessionId: "s" }),
  ).rejects.toThrow()
})

test("a state that cannot be sent is refused, and what was there stays", async () => {
  const deep = (depth: number): Json => (depth === 0 ? 1 : [deep(depth - 1)])
  const Holder = defineCapability({
    name: "Holder",
    state: Schema.Struct({ value: Schema.Json }),
    actions: (action) => ({
      TooDeep: action({
        handler: (_, state) => state.update(() => ({ value: deep(NODE_STATE_DEPTH_MAX) })),
      }),
      DeepAndLarge: action({
        handler: (_, state) =>
          state.update(() => ({
            value: {
              large: "x".repeat(NODE_STATE_CHARACTERS_MAX),
              deep: deep(NODE_STATE_DEPTH_MAX),
            },
          })),
      }),
    }),
  })
  const session = await pool.open(appFor(Holder, { value: 1 }))
  for (const action of ["TooDeep", "DeepAndLarge"]) {
    expect(await session.raw.dispatchRaw(action)).toMatchObject({
      status: "failed",
      error: { tag: "ResourceExhausted", defect: false },
    })
  }
  const { node } = await session.client.request("app.inspect", {})
  expect(node?.state).toEqual({ value: 1 })
})

test("state of an ordinary size is not refused for its number of values", async () => {
  const Rows = defineCapability({
    name: "Rows",
    state: Schema.Struct({
      rows: Schema.Array(Schema.Struct({ id: Schema.String, n: Schema.Int, on: Schema.Boolean })),
    }),
    actions: () => ({}),
  })
  const rows = Array.from({ length: 50_000 }, (_, n) => ({ id: `r${n}`, n, on: true }))
  const session = await pool.open(appFor(Rows, { rows }))
  const { node } = await session.client.request("app.inspect", {})
  expect(node?.name).toBe("Rows")
}, 60_000)

test("a defect beside a declared failure is still a defect, with its own message", async () => {
  const Both = defineCapability({
    name: "Both",
    state: Schema.Struct({}),
    actions: (action) => ({
      Go: action({
        error: Schema.String,
        handler: () =>
          Effect.failCause(
            Cause.combine(Cause.fail("expected"), Cause.die(new Error("cleanup defect"))),
          ),
      }),
    }),
  })
  const session = await pool.open(appFor(Both, {}))
  expect(await session.raw.dispatchRaw("Go")).toMatchObject({
    status: "failed",
    error: { defect: true, message: "cleanup defect" },
  })
})

test("a journey keeps a bounded history of large events", async () => {
  const text = "x".repeat(5 * 1024 * 1024)
  const Big = defineCapability({
    name: "Big",
    state: Schema.Struct({ n: Schema.Int, text: Schema.String }),
    actions: (action) => ({
      Grow: action({ handler: (_, state) => state.update(({ n }) => ({ n: n + 1, text })) }),
    }),
  })
  const session = await pool.open(appFor(Big, { n: 0, text: "" }))
  for (let index = 0; index < 20; index++) {
    await session.raw.dispatchRaw("Grow")
  }
  expect(JSON.stringify(session.events).length).toBeLessThan(64 * 1024 * 1024)
  expect(session.events.at(-1)).toMatchObject({ type: "operation.finished" })
})

test("a state at its limits can be inspected, and sent as an event", async () => {
  const deep = (depth: number): Json => (depth === 1 ? 1 : [deep(depth - 1)])
  const Holder = defineCapability({
    name: "Holder",
    state: Schema.Struct({ value: Schema.Json }),
    actions: (action) => ({
      Fill: action({
        handler: (_, state) =>
          state.update(() => ({ value: "x".repeat(NODE_STATE_CHARACTERS_MAX - 12) })),
      }),
      Deepen: action({
        // The state's own object and its one key take two of its levels.
        handler: (_, state) => state.update(() => ({ value: deep(NODE_STATE_DEPTH_MAX - 1) })),
      }),
    }),
  })
  const session = await pool.open(appFor(Holder, { value: 1 }))
  for (const action of ["Fill", "Deepen"]) {
    expect((await session.raw.dispatchRaw(action)).status).toBe("completed")
    const { node } = await session.client.request("app.inspect", {})
    expect(node?.name).toBe("Holder")
    const changed = session.events.filter(({ type }) => type === "state.changed")
    expect(changed.length).toBeGreaterThan(0)
    expect(session.events.at(-1)?.type).not.toBe("resync.required")
  }
  expect(session.events.map(({ type }) => type)).not.toContain("resync.required")
  // A tree holds every node, so only depth can be promised of it, not size.
  const { tree } = await session.client.request("app.inspect", { tree: true })
  expect(tree).toHaveLength(1)
})

test("a state whose escapes take it over the limit is refused, and what was there stays", async () => {
  const Holder = defineCapability({
    name: "Holder",
    state: Schema.Struct({ text: Schema.String }),
    actions: (action) => ({
      Fill: action({
        handler: (_, state) =>
          state.update(() => ({ text: "\\".repeat(NODE_STATE_CHARACTERS_MAX * 0.75) })),
      }),
    }),
  })
  const session = await pool.open(appFor(Holder, { text: "before" }))
  expect(await session.raw.dispatchRaw("Fill")).toMatchObject({
    status: "failed",
    error: { tag: "ResourceExhausted", defect: false },
  })
  const { node } = await session.client.request("app.inspect", {})
  expect(node?.state).toEqual({ text: "before" })
})

test("a limit reached beside a real crash does not hide the crash, in either order", async () => {
  const limit = new ProtocolError(ErrorCode.ResourceExhausted, "over the limit")
  const crash = new Error("cleanup defect")
  const Both = defineCapability({
    name: "Both",
    state: Schema.Struct({}),
    actions: (action) => ({
      LimitFirst: action({
        handler: () => Effect.failCause(Cause.combine(Cause.die(limit), Cause.die(crash))),
      }),
      CrashFirst: action({
        handler: () => Effect.failCause(Cause.combine(Cause.die(crash), Cause.die(limit))),
      }),
      InCleanup: action({
        handler: () => Effect.die(limit).pipe(Effect.ensuring(Effect.die(crash))),
      }),
      LimitOnly: action({ handler: () => Effect.die(limit) }),
    }),
  })
  const session = await pool.open(appFor(Both, {}))
  for (const action of ["LimitFirst", "CrashFirst", "InCleanup"]) {
    expect(await session.raw.dispatchRaw(action)).toMatchObject({
      error: { defect: true, message: "cleanup defect" },
    })
  }
  expect(await session.raw.dispatchRaw("LimitOnly")).toMatchObject({
    error: { tag: "ResourceExhausted", defect: false },
  })
})

test("failure data too large to carry is left out, and the failure still arrives", async () => {
  class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
    message: Schema.String,
    detail: Schema.String,
  }) {}
  const Refuser = defineCapability({
    name: "Refuser",
    state: Schema.Struct({}),
    actions: (action) => ({
      Go: action({
        error: Rejected,
        handler: () =>
          Effect.fail(
            new Rejected({ message: "no", detail: "x".repeat(NODE_STATE_CHARACTERS_MAX + 1) }),
          ),
      }),
    }),
  })
  const session = await pool.open(appFor(Refuser, {}))
  const operation = await session.raw.dispatchRaw("Go")
  expect(operation).toMatchObject({
    status: "failed",
    error: { tag: "Rejected", message: "no", defect: false },
  })
  expect(operation).not.toHaveProperty("error.data")
  expect(session.takeDefects()).toEqual([])
})

test("a state with as many values as allowed gets past redaction", () => {
  // The array itself is one of the visits.
  const values = new Array(REDACTION_VISITS_MAX - 2).fill(0)
  expect(redact(values)).toBe(values)
}, 60_000)

test("redaction finds secrets wherever they sit", async () => {
  const secret = Schema.Redacted(Schema.String)
  const Vault = defineCapability({
    name: "Vault",
    state: Schema.Struct({
      byName: Schema.ReadonlyMap(Schema.String, secret),
      all: Schema.ReadonlySet(secret),
      list: Schema.Array(secret),
      renamed: secret,
      plain: Schema.ReadonlyMap(Schema.String, Schema.Int),
    }).pipe(Schema.encodeKeys({ renamed: "wire_name" })),
    actions: () => ({}),
  })
  const session = await pool.open(
    appFor(Vault, {
      byName: new Map([["a", Redacted.make("hunter2")]]),
      all: new Set([Redacted.make("hunter3")]),
      list: [Redacted.make("hunter4")],
      renamed: Redacted.make("hunter5"),
      plain: new Map([["n", 1]]),
    }),
  )
  expect(JSON.stringify(session.raw.state)).not.toContain("hunter")
  expect(session.raw.state).toMatchObject({ plain: [["n", 1]], list: ["<redacted>"] })
})

test("a secret behind a getter or a hidden field does not get out", () => {
  const secret = Redacted.make("hunter2")
  const hiddenField = Object.defineProperty({}, "token", { value: secret, enumerable: false })
  expect(JSON.stringify(redact(hiddenField))).not.toContain("hunter2")
  expect(Redacted.isRedacted(Reflect.get(redact(hiddenField), "token"))).toBe(true)
  expect(Redacted.value(Reflect.get(redact(hiddenField), "token"))).toBe(REDACTED_TEXT)

  const getter = {
    get token() {
      return secret
    },
  }
  expect(() => redact(getter)).toThrow("accessor")

  class Inherited {
    get token() {
      return secret
    }
  }
  expect(() => redact(new Inherited())).toThrow("accessor")
  expect(() => redact({ nested: [{ deep: new Inherited() }] })).toThrow("accessor")
})

test("a secret on a prototype fails closed, as a copy would keep it", () => {
  const inherited = Object.create({ token: Redacted.make("hunter2") })
  expect(() => redact(inherited)).toThrow("prototype")
  const encode = secretFreeEncoder(Schema.Struct({ token: Schema.Redacted(Schema.String) }))
  expect(() => encode(inherited)).toThrow("prototype")
})

test("a secret also reachable through a getter fails closed, in either order", () => {
  const shared = { token: Redacted.make("hunter2") }
  const directFirst = {
    direct: shared,
    get viaGetter() {
      return shared
    },
  }
  const getterFirst = {
    get viaGetter() {
      return shared
    },
    direct: shared,
  }
  expect(() => redact(directFirst)).toThrow("accessor")
  expect(() => redact(getterFirst)).toThrow("accessor")
})

test("secrets in an Option are replaced", () => {
  const encode = secretFreeEncoder(Schema.Option(Schema.Redacted(Schema.String)))
  expect(JSON.stringify(encode(Option.some(Redacted.make("hunter2"))))).not.toContain("hunter2")
  expect(JSON.stringify(encode(Option.some(Redacted.make("hunter2"))))).toContain(REDACTED_TEXT)
  expect(encode(Option.none())).toBeDefined()
})

test("distinct secrets stay distinct", () => {
  const copy = redact(new Set([Redacted.make("a"), Redacted.make("b")]))
  expect(copy.size).toBe(2)
  const keyed = redact(
    new Map([
      [Redacted.make("a"), 1],
      [Redacted.make("b"), 2],
    ]),
  )
  expect(keyed.size).toBe(2)
})

test("very wide state fails closed rather than overflowing", () => {
  const wide = new Array(REDACTION_VISITS_MAX + 1).fill(0)
  expect(() => redact(wide)).toThrow(ProtocolError)
})

test("secrets in error subclasses are found, and the message survives", () => {
  class Failure extends Error {
    readonly token = Redacted.make("hunter2")
  }
  const copy = redact(new Failure("went wrong"))
  expect(copy).toBeInstanceOf(Failure)
  expect(copy.message).toBe("went wrong")
  expect(Redacted.value(copy.token)).toBe(REDACTED_TEXT)
})

test("structures that are cyclic inside can be encoded", () => {
  const encode = secretFreeEncoder(Schema.Chunk(Schema.Int))
  expect(encode(Chunk.make(1, 2))).toEqual([1, 2])
  const encodeSecret = secretFreeEncoder(Schema.Chunk(Schema.Redacted(Schema.String)))
  expect(encodeSecret(Chunk.make(Redacted.make("hunter2")))).toEqual([REDACTED_TEXT])
})

test("a redacted value that is not a string fails closed", async () => {
  const Numbers = defineCapability({
    name: "Numbers",
    state: Schema.Struct({ pin: Schema.Redacted(Schema.Int) }),
    actions: () => ({}),
  })
  const failing = pool.open(appFor(Numbers, { pin: Redacted.make(1234) }))
  await expect(failing).rejects.toBeDefined()
})

test("redaction reaches into nested and repeated values", async () => {
  const Vault = defineCapability({
    name: "Vault",
    state: Schema.Struct({
      accounts: Schema.Array(
        Schema.Struct({ name: Schema.String, key: Schema.Redacted(Schema.String) }),
      ),
    }),
    actions: () => ({}),
  })
  const session = await pool.open(
    appFor(Vault, {
      accounts: [
        { name: "a", key: Redacted.make("hunter2") },
        { name: "b", key: Redacted.make("hunter3") },
      ],
    }),
  )
  expect(session.raw.state).toEqual({
    accounts: [
      { name: "a", key: "<redacted>" },
      { name: "b", key: "<redacted>" },
    ],
  })
})

test("domain types cross the wire in their encoded form", async () => {
  const Dated = defineCapability({
    name: "Dated",
    state: Schema.Struct({ at: Schema.Date }),
    actions: (action) => ({
      Set: action({
        input: Schema.Struct({ at: Schema.Date }),
        handler: ({ at }, state) => {
          if (!(at instanceof Date)) {
            return Effect.die("handler must see the decoded type")
          }
          return state.update(() => ({ at }))
        },
      }),
    }),
  })
  const session = await pool.open(appFor(Dated, { at: new Date(0) }))
  expect(session.raw.state).toEqual({ at: "1970-01-01T00:00:00.000Z" })
  await session.raw.dispatchRaw("Set", { at: "2026-01-02T03:04:05.000Z" })
  expect(session.raw.state).toEqual({ at: "2026-01-02T03:04:05.000Z" })
  await expect(session.raw.dispatchRaw("Set", { at: 5 })).rejects.toMatchObject({
    code: ErrorCode.InvalidInput,
  })
})

test("a live node gives the UI stable snapshots and a typed send", async () => {
  const Counter = defineCapability({
    name: "Counter",
    state: Schema.Struct({ count: Schema.Int }),
    actions: (action) => ({
      Add: action({
        input: Schema.Struct({ by: Schema.Int }),
        handler: ({ by }, state) => state.update((s) => ({ count: s.count + by })),
      }),
      Clear: action({ handler: (_, state) => state.update(() => ({ count: 0 })) }),
    }),
  })
  const seen: Array<number> = []
  const host = defineApp({
    name: "ui",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(Counter, { count: 0 })
        const registry = yield* Registry
        registry.setFocus(node.id)
        const first = node.getSnapshot()
        expect(node.getSnapshot()).toBe(first)
        node.subscribe(() => seen.push(node.getSnapshot().count))
        yield* Effect.promise(() => dispatchDecoded(node, "Add", { by: 2 }))
        yield* Effect.promise(() => dispatchDecoded(node, "Clear"))
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  await pool.open(host)
  expect(seen).toEqual([2, 0])
})

test("sample only serves real actions", async () => {
  const session = await pool.open(app)
  await expect(session.client.request("app.sample", { action: "toString" })).rejects.toMatchObject({
    code: ErrorCode.ActionNotFound,
  })
  await expect(
    session.client.request("app.sample", {
      action: "Refresh",
      nodeId: toNodeId("screen/none"),
    }),
  ).rejects.toMatchObject({ code: ErrorCode.NodeNotFound })
})

test("state that cannot be published does not become the state", async () => {
  const Strict = defineCapability({
    name: "Strict",
    state: Schema.Struct({ n: Schema.Int }),
    actions: (action) => ({
      Break: action({ handler: (_, state) => state.update(() => ({ n: 1.5 })) }),
    }),
  })
  let readState = () => ({ n: 0 })
  const host = defineApp({
    name: "strict",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(Strict, { n: 1 })
        const registry = yield* Registry
        registry.setFocus(node.id)
        readState = node.getSnapshot
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  const session = await pool.open(host)
  expect(await session.raw.dispatchRaw("Break")).toMatchObject({
    status: "failed",
    error: { defect: true },
  })
  expect(session.raw.state).toEqual({ n: 1 })
  // The live state too, which is what a screen reads.
  expect(readState()).toEqual({ n: 1 })
})

test("a screen's send rejects on an input that will not encode, rather than throwing", async () => {
  const Bounded = defineCapability({
    name: "Bounded",
    state: Schema.Struct({}),
    actions: (action) => ({
      Go: action({
        input: Schema.Struct({ n: Schema.Int }),
        handler: () => Effect.void,
      }),
    }),
  })
  let sending: Promise<unknown> = Promise.resolve()
  const host = defineApp({
    name: "bounded",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(Bounded, {})
        sending = dispatchDecoded(node, "Go", { n: 1.5 })
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  await pool.open(host)
  await expect(sending).rejects.toBeDefined()
})

const focusHarness = (onFocus: () => Effect.Effect<unknown>) => {
  const Focusing = defineCapability({
    name: "Focusing",
    state: Schema.Struct({}),
    onFocus,
    actions: () => ({}),
  })
  const refocus = { run: () => {} }
  const host = defineApp({
    name: "focusing",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(Focusing, {})
        const registry = yield* Registry
        refocus.run = () => {
          registry.setFocus(null)
          registry.setFocus(node.id)
        }
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  return { host, refocus }
}

test("refocusing replaces the previous focus work instead of adding to it", async () => {
  let startCount = 0
  let cancelCount = 0
  const { host, refocus } = focusHarness(() =>
    Effect.sync(() => startCount++).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => cancelCount++)),
    ),
  )
  const session = await host.start("default", { sessionId: "focusing" })
  try {
    for (let index = 0; index < 3; index++) {
      refocus.run()
      await waitUntil(() => startCount === index + 1, "this focus's work has started")
    }
    expect(cancelCount).toBe(2)
  } finally {
    await session.dispose()
  }
})

test("focus work that is slow to cancel does not pile up behind it", async () => {
  let startCount = 0
  let release = () => {}
  const cancelled = new Promise<void>((resolve) => {
    release = resolve
  })
  const { host, refocus } = focusHarness(() =>
    Effect.sync(() => startCount++).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.promise(() => cancelled)),
    ),
  )
  const session = await host.start("default", { sessionId: "slow-focus" })
  try {
    refocus.run()
    for (let index = 0; index < 50; index++) {
      refocus.run()
    }
    await nextTurn()
    expect(startCount).toBe(1)
    release()
    await waitUntil(() => startCount === 2, "one more run starts, not fifty")
  } finally {
    release()
    await session.dispose()
  }
})

test("a focus hook that throws is that work's failure, not the navigation's", async () => {
  const Nav = defineNavigationFactories("test/Focus", { Home: NoParams, Broken: NoParams })
  const Broken = defineCapability({
    name: "Broken",
    state: Schema.Struct({}),
    onFocus: (): Effect.Effect<void> => {
      throw new Error("focus failed")
    },
    actions: () => ({}),
  })
  const Home = defineCapability({ name: "Home", state: Schema.Struct({}), actions: () => ({}) })
  const host = defineApp({
    name: "focus",
    defaultScenario: "default",
    root: Nav.layer({
      initial: { route: "Home", params: {} },
      screens: { Home: () => mount(Home, {}), Broken: () => mount(Broken, {}) },
    }),
    scenarios: { default: { layer: Layer.empty } },
  })
  const session = await pool.open(host)
  expect(await session.raw.dispatchRaw("Navigate", { route: "Broken", params: {} })).toMatchObject({
    status: "completed",
  })
  await session.raw.precondition("Broken")
  expect(session.takeDefects()).toEqual([expect.stringContaining("focus failed")])
})

test("a node is only returned for the capability that made it", async () => {
  const state = Schema.Struct({ value: Schema.Int })
  const First = defineCapability({ name: "Shared", state, actions: () => ({}) })
  const Second = defineCapability({ name: "Shared", state, actions: () => ({}) })
  let found: Array<unknown> = []
  const host = defineApp({
    name: "identity",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(First, { value: 42 })
        const runtime = yield* Registry
        found = [liveNodeOf(runtime, node.id, First), liveNodeOf(runtime, node.id, Second)]
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  await pool.open(host)
  expect(found[0]).toBeDefined()
  expect(found[1]).toBeUndefined()
})

test("a secret in an action's input reaches the handler, and goes no further", async () => {
  const received: Array<string> = []
  const Login = defineCapability({
    name: "Login",
    state: Schema.Struct({}),
    actions: (action) => ({
      SignIn: action({
        input: Schema.Struct({ password: Schema.Redacted(Schema.String) }),
        handler: ({ password }) =>
          Effect.sync(() => {
            received.push(Redacted.value(password))
          }),
      }),
    }),
  })
  let signing: Promise<unknown> = Promise.resolve()
  const host = defineApp({
    name: "login",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(Login, {})
        const registry = yield* Registry
        registry.setFocus(node.id)
        signing = dispatchDecoded(node, "SignIn", { password: Redacted.make("hunter2") })
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  const session = await pool.open(host)
  await signing
  expect(received).toEqual(["hunter2"])
  expect(JSON.stringify(session.events)).not.toContain("hunter2")
})

test("a live subscriber that throws cannot fail the action or starve the others", async () => {
  const Counter = defineCapability({
    name: "Counter",
    state: Schema.Struct({ n: Schema.Int }),
    actions: (action) => ({
      Add: action({ handler: (_, state) => state.update((s) => ({ n: s.n + 1 })) }),
    }),
  })
  const seen: Array<number> = []
  const host = defineApp({
    name: "subscribers",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(Counter, { n: 0 })
        const registry = yield* Registry
        registry.setFocus(node.id)
        node.subscribe(() => {
          throw new Error("subscriber failed")
        })
        node.subscribe(() => seen.push(node.getSnapshot().n))
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  const session = await pool.open(host)
  expect((await session.raw.dispatchRaw("Add")).status).toBe("completed")
  expect(seen).toEqual([1])
})

test("node listeners are capped", async () => {
  const Plain = defineCapability({ name: "Plain", state: Schema.Struct({}), actions: () => ({}) })
  let overflow: unknown
  const host = defineApp({
    name: "listeners",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(Plain, {})
        try {
          for (let index = 0; index <= NODE_LISTENERS_MAX; index++) {
            node.subscribe(() => undefined)
          }
        } catch (error: unknown) {
          overflow = error
        }
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  await pool.open(host)
  expect(overflow).toMatchObject({ code: ErrorCode.ResourceExhausted })
})

test("a sample is a valid input, whatever the schema demands of its secrets", async () => {
  const Login = defineCapability({
    name: "Login",
    state: Schema.Struct({}),
    actions: (action) => ({
      SignIn: action({
        input: Schema.Struct({
          password: Schema.Redacted(Schema.String.check(Schema.isMinLength(20))),
        }),
        handler: () => Effect.void,
      }),
    }),
  })
  const session = await pool.open(appFor(Login, {}))
  const { input } = await session.client.request("app.sample", { action: "SignIn", seed: 1 })
  expect((await session.raw.dispatchRaw("SignIn", input)).status).toBe("completed")
})

test("an action taking anything is sent its input; one taking nothing is sent none", async () => {
  const received: Array<unknown> = []
  const Any = defineCapability({
    name: "Any",
    state: Schema.Struct({}),
    actions: (action) => ({
      Accept: action({
        input: Schema.Unknown,
        handler: (input) =>
          Effect.sync(() => {
            received.push(input)
          }),
      }),
      Ping: action({ handler: () => Effect.void }),
    }),
  })
  let sending: Promise<unknown> = Promise.resolve()
  const host = defineApp({
    name: "any",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(Any, {})
        const registry = yield* Registry
        registry.setFocus(node.id)
        sending = Promise.all([
          dispatchDecoded(node, "Accept", { value: 42 }),
          dispatchDecoded(node, "Accept", null),
          dispatchDecoded(node, "Ping"),
        ])
        // @ts-expect-error An action without an input takes no argument.
        void (() => dispatchDecoded(node, "Ping", { value: 42 }))
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  await pool.open(host)
  await sending
  expect(received).toEqual([{ value: 42 }, null])
})

test("a queued refocus does not start once the node has gone", async () => {
  let startCount = 0
  const { host, refocus } = focusHarness(() =>
    Effect.sync(() => startCount++).pipe(Effect.andThen(Effect.never)),
  )
  const session = await host.start("default", { sessionId: "retired" })
  refocus.run()
  refocus.run()
  await session.dispose()
  await nextTurn()
  expect(startCount).toBe(1)
})

test("refined secrets publish initial state, updates and typed error events", async () => {
  const secret = Schema.Redacted(
    Schema.String.check(Schema.isMinLength(24), Schema.isPattern(/^secret-/)),
  )
  const value = "secret-123456789012345678901234"
  class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
    message: Schema.String,
    token: secret,
  }) {}
  const Vault = defineCapability({
    name: "RefinedVault",
    state: Schema.Struct({ token: secret, count: Schema.Int }),
    actions: (action) => ({
      Change: action({
        input: Schema.Struct({ token: secret }),
        handler: ({ token }, state) => state.update(() => ({ token, count: 1 })),
      }),
      Reject: action({
        input: Schema.Struct({ token: secret }),
        error: Rejected,
        handler: ({ token }) => Effect.fail(new Rejected({ message: "denied", token })),
      }),
    }),
  })
  const session = await pool.open(appFor(Vault, { token: Redacted.make(value), count: 0 }))
  expect(session.raw.state).toEqual({ token: REDACTED_TEXT, count: 0 })
  expect(await session.raw.dispatchRaw("Change", { token: value })).toMatchObject({
    status: "completed",
  })
  expect(session.raw.state).toEqual({ token: REDACTED_TEXT, count: 1 })
  expect(await session.raw.dispatchRaw("Reject", { token: value })).toMatchObject({
    status: "failed",
    error: { defect: false, data: { token: REDACTED_TEXT } },
  })
  expect(JSON.stringify(session.events)).not.toContain(value)
  await expect(session.raw.dispatchRaw("Change", { token: "short" })).rejects.toBeDefined()
})

test("redaction preserves Map and Set insertion order across rebuilt Options", () => {
  const first = Option.some(Redacted.make("first"))
  const nested = Option.some(Option.some(Redacted.make("nested")))
  const values = [first, "plain", nested, "last"]
  const set = redact(new Set(values))
  expect([...set].map((value) => (typeof value === "string" ? value : "option"))).toEqual([
    "option",
    "plain",
    "option",
    "last",
  ])
  const map = redact(new Map(values.map((key, index) => [key, index])))
  expect([...map.values()]).toEqual([0, 1, 2, 3])
  const mapValues = redact(
    new Map<number, unknown>([
      [0, first],
      [1, nested],
    ]),
  )
  expect([...mapValues.keys()]).toEqual([0, 1])
})

test("a declared focus failure reaches the session reporter", async () => {
  const reported: Array<unknown> = []
  const Loading = defineCapability({
    name: "Loading",
    state: Schema.Struct({ loading: Schema.Boolean }),
    // @ts-expect-error An untyped caller can still violate the focus error contract at runtime.
    onFocus: () => Effect.fail({ _tag: "Offline", message: "focus offline" }),
    actions: () => ({}),
  })
  const host = defineApp({
    name: "focus-reporting",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(Loading, { loading: true })
        const registry = yield* Registry
        registry.setFocus(node.id)
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  const session = await host.start("default", {
    sessionId: "focus-reporting",
    onBackgroundError: (error) => reported.push(error),
  })
  try {
    await session.runtime.wait({ idle: true })
    await nextTurn()
    expect(reported).toEqual([
      expect.objectContaining({ message: expect.stringContaining("focus offline") }),
    ])
  } finally {
    await session.dispose()
  }
})

test("refined secret views retain options, containers, renamed keys and value codecs", () => {
  const plain = Schema.String.check(Schema.isMinLength(24), Schema.isPattern(/^secret-/))
  const secret = Schema.Redacted(plain)
  const token = Redacted.make("secret-123456789012345678901234")
  const schema = Schema.Struct({
    optional: Schema.optionalKey(secret),
    option: Schema.Option(secret),
    map: Schema.ReadonlyMap(Schema.String, secret),
    set: Schema.ReadonlySet(secret),
    fromValue: Schema.RedactedFromValue(plain),
  }).pipe(Schema.encodeKeys({ fromValue: "wire_token" }))
  const encode = secretFreeEncoder(schema)
  expect(
    encode({
      optional: token,
      option: Option.some(token),
      map: new Map([["a", token]]),
      set: new Set([token]),
      fromValue: token,
    }),
  ).toEqual({
    optional: REDACTED_TEXT,
    option: { _tag: "Some", value: REDACTED_TEXT },
    map: [["a", REDACTED_TEXT]],
    set: [REDACTED_TEXT],
    wire_token: REDACTED_TEXT,
  })
  expect(() =>
    encode({
      option: Option.none(),
      map: new Map(),
      set: new Set(),
      fromValue: Redacted.make("bad"),
    }),
  ).toThrow("schema")
  const forbidden = secretFreeEncoder(Schema.Redacted(plain, { disallowJsonEncode: true }))
  expect(() => forbidden(token)).toThrow()
})

test("literal secrets and parent refinements validate the real value before publishing", () => {
  const secret = Schema.RedactedFromValue(Schema.Literal("only-secret"))
  const schema = Schema.Struct({ token: secret, count: Schema.Int })
    .check(Schema.makeFilter((value) => Redacted.value(value.token) === "only-secret"))
    .pipe(Schema.encodeKeys({ token: "renamed" }))
  const encode = secretFreeEncoder(schema)
  expect(encode({ token: Redacted.make("only-secret"), count: 1 })).toEqual({
    renamed: REDACTED_TEXT,
    count: 1,
  })
  expect(() => encode({ token: Redacted.make("only-secret"), count: 1.5 })).toThrow("schema")
})

test("publishing recursively defined schemas keeps refined secrets redacted", () => {
  interface Tree {
    readonly token: Redacted.Redacted<string>
    readonly children: ReadonlyArray<Tree>
  }
  const token = Schema.Redacted(Schema.String.check(Schema.isMinLength(24)))
  const tree: Schema.Codec<Tree> = Schema.suspend(() =>
    Schema.Struct({ token, children: Schema.Array(tree) }),
  )
  const secret = Redacted.make("recursive-secret-1234567890")
  expect(
    secretFreeEncoder(tree)({ token: secret, children: [{ token: secret, children: [] }] }),
  ).toEqual({
    token: REDACTED_TEXT,
    children: [{ token: REDACTED_TEXT, children: [] }],
  })
})

test("renamed secrets can have enum and non-string encoded representations", () => {
  const schema = Schema.Struct({
    enumToken: Schema.RedactedFromValue(Schema.Enum({ One: "secret-one", Two: "secret-two" })),
    numericToken: Schema.RedactedFromValue(Schema.flip(Schema.NumberFromString)),
  }).pipe(Schema.encodeKeys({ enumToken: "enum_token", numericToken: "numeric_token" }))
  expect(
    secretFreeEncoder(schema)({
      enumToken: Redacted.make("secret-one"),
      numericToken: Redacted.make("12345678"),
    }),
  ).toEqual({ enum_token: REDACTED_TEXT, numeric_token: REDACTED_TEXT })
})

test("publishing schema depth and node count have exact bounds", () => {
  let schema: Schema.Codec<unknown> = Schema.Unknown
  for (let depth = 0; depth < SCHEMA_DEPTH_MAX; depth++) {
    schema = Schema.Array(schema)
  }
  expect(() => secretFreeEncoder(schema)).not.toThrow()
  expect(() => secretFreeEncoder(Schema.Array(schema))).toThrow(ProtocolError)
  const fields = Object.fromEntries(
    Array.from({ length: SCHEMA_NODES_MAX - 1 }, (_, index) => [
      `field${index}`,
      Schema.Literal(index),
    ]),
  )
  expect(() => secretFreeEncoder(Schema.Struct(fields))).not.toThrow()
  expect(() => secretFreeEncoder(Schema.Struct({ ...fields, extra: Schema.Boolean }))).toThrow(
    ProtocolError,
  )
})

test("plain placeholder text still follows its own codec beside a secret", () => {
  const upper = Schema.String.pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) => value),
      encode: SchemaGetter.transform((value) => value.toUpperCase()),
    }),
  )
  const encode = secretFreeEncoder(
    Schema.Struct({ token: Schema.Redacted(Schema.String), plain: upper }),
  )
  expect(encode({ token: Redacted.make("secret"), plain: REDACTED_TEXT })).toEqual({
    token: REDACTED_TEXT,
    plain: "<REDACTED>",
  })
})

test("Option own properties are scanned, copied and redacted", () => {
  const token = Redacted.make("option-property-secret")
  const none: object = Object.create(Object.getPrototypeOf(Option.none()))
  const values = [Object.assign(Option.some(0), { token }), Object.assign(none, { token })]
  const encode = secretFreeEncoder(Schema.Struct({ token: Schema.Redacted(Schema.String) }))
  for (const value of values) {
    expect(encode(value)).toEqual({ token: REDACTED_TEXT })
  }
  const shared = Option.some(token)
  const copy = redact({ first: shared, second: shared })
  expect(copy.first).toBe(copy.second)
})

test("secrets attached to ArrayBuffer views fail closed, while ordinary views survive copying", () => {
  const token = Redacted.make("view-property-secret")
  for (const view of [new Uint8Array([1]), new DataView(new ArrayBuffer(1))]) {
    const value = Object.assign(view, { token })
    expect(() =>
      secretFreeEncoder(Schema.Struct({ token: Schema.Redacted(Schema.String) }))(value),
    ).toThrow("ArrayBuffer view")
  }
  const bytes = new Uint8Array([1, 2])
  const copy = redact({ bytes, token })
  expect(copy.bytes).toBe(bytes)
  expect(Array.from(copy.bytes)).toEqual([1, 2])
})

test("native views are bounded before allocating their indexed property list", () => {
  expect(() => redact(new Uint8Array(REDACTION_VIEW_BYTES_MAX + 1))).toThrow(
    "ArrayBuffer view is too large",
  )
})

test("state capabilities reject reads and transitions after their owning scope closes", async () => {
  const { createRuntime } = await import("@reflex/runtime/internal")
  const { mountWithAccess } = await import("@reflex/effect/internal")
  const runtime = createRuntime({ sessionId: "closed-state-access" })
  const Counter = defineCapability({
    name: "Counter",
    state: Schema.Struct({ count: Schema.Int }),
    actions: () => ({}),
  })
  const { node, access } = await Effect.runPromise(
    Effect.scoped(
      mountWithAccess(Counter, { count: 0 }).pipe(Effect.provideService(Registry, runtime)),
    ),
  )
  let called = false
  const sequence = runtime.sequence
  const read = await Effect.runPromiseExit(access.get)
  const write = await Effect.runPromiseExit(
    access.update(() => {
      called = true
      return { count: 99 }
    }),
  )
  expect(read._tag === "Failure" && Cause.hasInterruptsOnly(read.cause)).toBe(true)
  expect(write._tag === "Failure" && Cause.hasInterruptsOnly(write.cause)).toBe(true)
  expect(called).toBe(false)
  expect(node.getSnapshot()).toEqual({ count: 0 })
  expect(runtime.sequence).toBe(sequence)
})

test("Effect wire publication detaches and deeply freezes unknown JSON values", () => {
  const encode = secretFreeEncoder(Schema.Struct({ value: Schema.Unknown }))
  const initial = { value: { rows: [{ count: 1 }] } }
  const published = encode(initial)
  initial.value.rows[0] = { count: 99 }
  expect(published).toEqual({ value: { rows: [{ count: 1 }] } })
  const frozen = (value: Json): boolean =>
    value === null ||
    typeof value !== "object" ||
    (Object.isFrozen(value) && Object.values(value).every(frozen))
  expect(frozen(published)).toBe(true)
})
