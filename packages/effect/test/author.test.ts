import { legacyApp } from "@reflex/effect/internal"
import { afterEach, expect, test } from "bun:test"
import { Screen, defineApp, defineFixture, defineService, defineNavigation } from "@reflex/effect"
import { createTestAppPool } from "@reflex/test"
import { createController, type AppHost, type Controller } from "@reflex/runtime/internal"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type { Erased } from "../src/erased.ts"

const pool = createTestAppPool()
afterEach(() => pool.disposeAll())

class Count extends Context.Service<Count, number>()("author/Count") {}
class Other extends Context.Service<Other, number>()("author/Other") {}
const Counter = defineService({
  name: "Counter",
  state: Schema.Number,
  initial: () => 0,
  actions: (a) => ({
    Set: a({ input: Schema.NumberFromString, handler: (input, { state }) => state.set(input) }),
    Error: a({ error: Schema.NumberFromString, handler: () => Effect.fail(12) }),
    Die: a({ handler: () => Effect.die(new Error("broken")) }),
  }),
})

test("author actions decode once, encode errors, and retain defect outcomes", async () => {
  const app = await pool.open(legacyApp(defineApp({ name: "author", services: [Counter] })))
  const node = await app.node(Counter)
  await node.actions.Set("7")
  expect(await node.state()).toBe(7)
  expect(await node.expectFailure.Error()).toMatchObject({
    status: "domain-error",
    error: { data: "12" },
  })
  expect(await app.raw.dispatchRaw("Die")).toMatchObject({
    status: "failed",
    error: { defect: true, message: "broken" },
  })
})

class Home extends Screen("Home", { state: Schema.Number, initial: () => 0 }) {}
class Detail extends Screen("Detail", {
  state: Schema.Number,
  params: { id: Schema.NumberFromString },
  initial: ({ id }) => id,
}) {}
const Nav = defineNavigation({ Home, Detail })
const home = Home.implement({
  actions: (a) => ({
    Open: a.navigates({
      handler: (_, { state }) => Effect.as(state.set(1), Nav.push(Detail, { id: 2 })),
    }),
    Back: a.navigates({ handler: () => Nav.back, onRefused: (_, { state }) => state.set(-1) }),
    Stay: a.navigates({ handler: () => Effect.succeed(Nav.stay) }),
  }),
})
const detail = Detail.implement({
  actions: (a) => ({
    Back: a.navigates({ handler: () => Nav.back }),
  }),
})
const navigation = Nav.implement([home, detail], { initial: Home })

test("push and back complete their handlers before retiring a screen; root back is refused", async () => {
  const app = await pool.open(legacyApp(defineApp({ name: "navigation", navigation })))
  const first = await app.focused(home)
  expect(await first.expectRefusal.Back()).toMatchObject({
    status: "refused",
    reason: "Already at the root screen",
  })
  expect(await first.state()).toBe(-1)
  await first.actions.Stay()
  await first.actions.Open()
  const second = await app.focused(detail)
  expect(await first.state()).toBe(1)
  expect(await second.state()).toBe(2)
  await second.actions.Back()
  await app.focused(home)
  expect(
    app.events
      .filter((e) => e.type === "operation.finished")
      .every((e) => e.type !== "operation.finished" || e.operation.status !== "cancelled"),
  ).toBe(true)
})

const Toggle = Screen.define("Toggle", {
  state: Schema.Union([
    Schema.TaggedStruct("ready", { value: Schema.Number }),
    Schema.TaggedStruct("done", {}),
  ]),
  initial: () => ({ _tag: "ready", value: 0 }),
  actions: (a) => ({
    Finish: a.when("ready").reduce({ reducer: () => ({ _tag: "done" }) }),
    Increment: a
      .when("ready")
      .reduce({ reducer: (_, state) => ({ ...state, value: state.value + 1 }) }),
  }),
})
const ToggleNav = defineNavigation({ Toggle })
test("Screen.define preserves identity and when guards refuse before invoking a reducer", async () => {
  const app = await pool.open(
    legacyApp(
      defineApp({ name: "guards", navigation: ToggleNav.implement([Toggle], { initial: Toggle }) }),
    ),
  )
  const node = await app.focused(Toggle)
  await node.actions.Increment()
  expect(await node.state()).toEqual({ _tag: "ready", value: 1 })
  await node.actions.Finish()
  expect(await node.expectRefusal.Increment()).toMatchObject({
    status: "refused",
    reason: "Requires ready state",
  })
})

const Fixture = defineFixture({
  name: "Fixture",
  state: Schema.Number,
  initial: () => 0,
  actions: (a) => ({
    Increment: a.reduce({ reducer: (_, n) => n + 1 }),
    ReadService: a({ handler: (_, { state }) => Effect.flatMap(Count, (n) => state.set(n)) }),
  }),
})
const Reader = defineService({
  name: "Reader",
  state: Schema.Number,
  initial: () => 0,
  actions: (a) => ({
    Read: a({ handler: (_, { state }) => Effect.flatMap(Count, (n) => state.set(n)) }),
  }),
})
const fixtureApp = defineApp({
  name: "fixture",
  services: [Reader],
  layer: Layer.effect(
    Count,
    Effect.map(Fixture, () => 3),
  ),
  fixtures: [Fixture],
  scenarios: { first: {}, second: { layer: Layer.succeed(Count, 9) } },
  defaultScenario: "first",
})
test("fixtures precede common and scenario layers, handlers see overrides, and reset rebuilds fixture state", async () => {
  const app = await pool.open(legacyApp(fixtureApp))
  const fixture = await app.node(Fixture)
  await fixture.actions.Increment()
  await (await app.node(Reader)).actions.Read()
  expect(await (await app.node(Reader)).state()).toBe(3)
  await fixture.actions.ReadService()
  expect(await fixture.state()).toBe(3)
  await app.reset("second")
  expect(await (await app.node(Fixture)).state()).toBe(0)
  await (await app.node(Reader)).actions.Read()
  expect(await (await app.node(Reader)).state()).toBe(9)
})

test("scenario-specific fixtures do not mount in scenarios that opt out", async () => {
  const app = defineApp({ name: "isolation", layer: Layer.succeed(Count, 1) }).withScenarios(
    { withFixture: {}, withoutFixture: { fixtures: [] } },
    { defaultScenario: "withFixture", fixtures: [Fixture] },
  )
  const controller = await createController(legacyApp(app))
  try {
    expect((await controller.request("app.inspect", { name: "Fixture" })).node).not.toBeNull()
    await controller.request("app.reset", { scenario: "withoutFixture" })
    await expect(controller.request("app.inspect", { name: "Fixture" })).rejects.toThrow(
      "No active node",
    )
  } finally {
    await controller.close()
  }
})

const unsafeApp = (spec: Erased): AppHost => legacyApp((defineApp as Erased)(spec))
for (const [stage, layer, scenarios] of [
  [
    "common",
    Layer.effect(
      Count,
      Effect.map(Other, (n) => n),
    ),
    { default: { layer: Layer.succeed(Other, 2) } },
  ],
  [
    "scenario",
    Layer.empty,
    {
      default: {
        layer: Layer.effect(
          Count,
          Effect.map(Count, (n) => n),
        ),
      },
    },
  ],
] as const) {
  test(`runtime rejects missing ${stage} inputs, including a layer trying to satisfy itself`, async () => {
    const app = unsafeApp({ name: stage, services: [Reader], layer, scenarios })
    await expect(createController(app)).rejects.toThrow("Service not found")
  })
}

test("discarded commands and foreign navigator owners are defects with actionable diagnostics", async () => {
  const Foreign = defineNavigation({ Home, Detail }, { key: "foreign" })
  const broken = Home.implement({
    actions: (a) => ({
      Dropped: a({
        handler: () =>
          Effect.sync(() => {
            Nav.back
          }),
      }),
      Foreign: a.navigates({ handler: () => Foreign.push(Detail, { id: 1 }) }),
    }),
  })
  const app = unsafeApp({
    name: "broken",
    navigation: Nav.implement([broken, detail], { initial: Home }),
  })
  const controller: Controller = await createController(app)
  try {
    expect(
      await controller.request("app.dispatch", { action: "Dropped", await: true }),
    ).toMatchObject({
      status: "failed",
      error: { defect: true, message: expect.stringContaining("discarded") },
    })
    expect(
      await controller.request("app.dispatch", { action: "Foreign", await: true }),
    ).toMatchObject({
      status: "failed",
      error: {
        defect: true,
        message: expect.stringContaining("Action Foreign requires navigator 'foreign'"),
      },
    })
  } finally {
    await controller.close()
  }
})

test("a suspended guarded write refuses instead of overwriting a new variant", async () => {
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const Guard = defineService({
    name: "Guard",
    state: Schema.Union([
      Schema.TaggedStruct("ready", { value: Schema.Number }),
      Schema.TaggedStruct("done", {}),
    ]),
    initial: () => ({ _tag: "ready", value: 0 }),
    actions: (a) => ({
      Slow: a.when("ready")({
        handler: (_, { state }) =>
          Effect.gen(function* () {
            entered.resolve()
            yield* Effect.promise(() => resume.promise)
            yield* state.update((s) => ({ ...s, value: s.value + 1 }))
          }),
      }),
      Finish: a.when("ready").reduce({ reducer: () => ({ _tag: "done" }) }),
    }),
  })
  const app = await pool.open(legacyApp(defineApp({ name: "stale", services: [Guard] })))
  const operation = await app.raw.start("Slow")
  await entered.promise
  await app.client.request("app.dispatch", { action: "Finish", await: true })
  resume.resolve()
  await app.waitFor({ operationId: operation.operationId })
  expect(
    await app.client.request("app.operation", { operationId: operation.operationId }),
  ).toMatchObject({ status: "failed", error: { tag: "StateChanged", defect: false } })
  expect(await (await app.node(Guard)).state()).toEqual({ _tag: "done" })
})

test("each action closes its child scope before reporting completion", async () => {
  let finalized = 0
  const Scoped = defineService({
    name: "Scoped",
    state: Schema.Number,
    initial: () => 0,
    actions: (a) => ({
      Run: a({
        handler: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalized++
              }),
            )
            yield* Effect.forkScoped(Effect.never)
          }),
      }),
    }),
  })
  const app = await pool.open(legacyApp(defineApp({ name: "scoped", services: [Scoped] })))
  await (await app.node(Scoped)).actions.Run()
  expect(finalized).toBe(1)
})

test("jsonCodec supplies the actual input, state, and error wire representation", async () => {
  const { jsonCodec } = await import("@reflex/effect/advanced")
  const codec = jsonCodec(Schema.NumberFromString, {
    encode: (n: number) => ({ value: n }),
    decode: (raw) =>
      Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.Number }))(raw).pipe(
        Effect.map((s) => s.value),
      ),
    jsonSchema: {
      type: "object",
      required: ["value"],
      properties: { value: { type: "number" } },
      additionalProperties: false,
    },
  })
  const Wire = defineService({
    name: "Wire",
    state: codec,
    initial: () => 0,
    actions: (a) => ({
      Set: a({ input: codec, handler: (n, { state }) => state.set(n) }),
      Fail: a({ error: codec, handler: () => Effect.fail(3) }),
    }),
  })
  const app = await pool.open(legacyApp(defineApp({ name: "wire", services: [Wire] })))
  const node = await app.node(Wire)
  await node.actions.Set({ value: 2 })
  expect(await node.state()).toEqual({ value: 2 })
  expect(await node.expectFailure.Fail()).toMatchObject({
    status: "domain-error",
    error: { data: { value: 3 } },
  })
  expect((await app.inspectRaw("Wire")).actions.Set?.inputSchema).toMatchObject({
    type: "object",
    required: ["value"],
  })
})

test("contract names survive differently named classes and exact constructor ownership is enforced", async () => {
  class DifferentClassName extends Screen("DeclaredName", {
    state: Schema.Number,
    initial: () => 0,
  }) {}
  const Nav = defineNavigation({ DeclaredName: DifferentClassName })
  const definition = DifferentClassName.implement({
    actions: (a) => ({ Again: a.navigates({ handler: () => Nav.push(DifferentClassName) }) }),
  })
  const app = await pool.open(
    legacyApp(
      defineApp({
        name: "names",
        navigation: Nav.implement([definition], { initial: DifferentClassName }),
      }),
    ),
  )
  expect((await app.inspectRaw("DeclaredName")).name).toBe("DeclaredName")
  await (await app.focused(definition)).actions.Again()
  expect((await app.inspect()).focus).toContain("DeclaredName")
  class Subclass extends DifferentClassName {}
  const wrong = DifferentClassName.implement({
    actions: (a) => ({ Wrong: a.navigates({ handler: () => Nav.push(Subclass) }) }),
  })
  const other = await pool.open(
    legacyApp(
      defineApp({
        name: "constructor",
        navigation: Nav.implement([wrong], { initial: DifferentClassName }),
      }),
    ),
  )
  expect(await other.raw.dispatchRaw("Wrong")).toMatchObject({
    status: "failed",
    error: { defect: true, message: expect.stringContaining("exact DeclaredName contract") },
  })
})
