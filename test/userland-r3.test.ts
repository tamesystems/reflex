import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { afterEach, expect, test } from "bun:test"
import { defineApp, defineNavigation, defineScreen } from "@reflex/effect"
import { liveNodeOf } from "@reflex/effect/internal"
import { createRuntime, mountSessionRoute, definitionIdentity } from "@reflex/runtime/internal"
import { defineStoreApp, defineStoreNode, standardInput } from "@reflex/runtime"
import { createTestAppPool } from "@reflex/test"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { z } from "zod"
import { expoRoutes } from "../packages/expo/src/routes-effect.ts"

const pool = createTestAppPool()
afterEach(pool.disposeAll)

class Amount extends Context.Service<Amount, number>()("round3/Amount") {}
const Count = defineScreen({ name: "Count", state: Schema.NumberFromString, initial: () => 1 })
const Nav = defineNavigation("round3/Navigation", { Count })
const Counter = Count.implement({
  actions: (action) => ({
    Add: action({
      handler: (_, state) => Effect.flatMap(Amount, (amount) => state.update((n) => n + amount)),
    }),
  }),
})
const app = defineApp({
  name: "round3",
  navigation: Nav.implement({ Count: Counter }, { initial: "Count" }),
  scenarios: { default: { layer: Layer.succeed(Amount, 1) } },
  defaultScenario: "default",
})

test("navigation preserves transformed state and contract lookup across implementations", async () => {
  const session = await pool.open(app)
  const count = await session.focused(Counter)
  expect(await count.state()).toBe("1")
  await count.actions.Add()
  expect(await count.state()).toBe("2")
  const live = await app.start("default", { sessionId: "identity" })
  try {
    const second = Count.implement({ actions: () => ({}) })
    const id = live.runtime.focus
    expect(id).not.toBeNull()
    if (id === null) {
      throw new Error("Expected focus")
    }
    expect(liveNodeOf(live.runtime, id, second)).toBeDefined()
  } finally {
    await live.dispose()
  }
})

test("composition rejects foreign contracts and duplicate implementations immediately", () => {
  const clone = defineScreen({
    name: "Count",
    state: Schema.NumberFromString,
    initial: () => 1,
  }).implement({ actions: () => ({}) })
  expect(() => Nav.layer({ screens: { Count: clone }, initial: "Count" })).toThrow(
    "must implement its registered contract",
  )
  const Duplicate = defineNavigation("duplicate", { One: Count, Two: Count })
  expect(() =>
    Duplicate.layer({ screens: { One: Counter, Two: Counter }, initial: "One" }),
  ).toThrow("duplicate implementations")
  expect(() =>
    defineApp({
      name: "conflict",
      navigation: Nav.implement({ Count: Counter }, { initial: "Count" }),
      fixtures: { Clone: clone },
      scenarios: { default: { layer: Layer.succeed(Amount, 1) } },
      defaultScenario: "default",
    }),
  ).toThrow('conflicting definitions named "Count"')
})

test("journey membership rejects an independent same-name definition", async () => {
  const session = await pool.open(app)
  const clone = defineScreen({
    name: "Count",
    state: Schema.NumberFromString,
    initial: () => 1,
  }).implement({
    actions: (action) => ({ Add: action({ handler: (_, state) => state.update((n) => n + 1) }) }),
  })
  await expect(session.node(clone)).rejects.toThrow("not a contract")
})

test("un-narrowed journey state follows legitimate union transitions", async () => {
  const Contract = defineScreen({
    name: "Union",
    state: Schema.Union([Schema.TaggedStruct("one", {}), Schema.TaggedStruct("two", {})]),
    initial: () => ({ _tag: "one" }),
  })
  const Union = Contract.implement({
    actions: (action) => ({
      Next: action({ handler: (_, state) => state.update(() => ({ _tag: "two" })) }),
    }),
  })
  const navigation = defineNavigation("union", { Union: Contract })
  const host = defineApp({
    name: "union",
    navigation: navigation.implement({ Union }, { initial: "Union" }),
    scenarios: { default: { layer: Layer.empty } },
    defaultScenario: "default",
  })
  const session = await pool.open(host)
  const node = await session.node(Union)
  const focused = await session.focused(Union)
  const narrowed = await session.focused(Union, { _tag: "one" })
  await node.actions.Next()
  expect(await node.state()).toEqual({ _tag: "two" })
  expect(await focused.state()).toEqual({ _tag: "two" })
  await expect(narrowed.state()).rejects.toThrow("changed state tag")
})

test("back completes the calling action before retiring its screen", async () => {
  const Home = defineScreen({ name: "Home", state: Schema.Number, initial: () => 0 })
  const Detail = defineScreen({ name: "Detail", state: Schema.Number, initial: () => 0 })
  const nav = defineNavigation("return", { Home, Detail })
  const home = Home.implement({
    actions: (action) => ({ Open: action({ handler: () => nav.push("Detail") }) }),
  })
  const detail = Detail.implement({
    actions: (action) => ({ SaveAndClose: action({ handler: () => nav.back }) }),
  })
  const host = defineApp({
    name: "return",
    navigation: nav.implement({ Home: home, Detail: detail }, { initial: "Home" }),
    scenarios: { default: { layer: Layer.empty } },
    defaultScenario: "default",
  })
  const session = await pool.open(host)
  await (await session.focused(home)).actions.Open()
  expect(await (await session.focused(detail)).actions.SaveAndClose()).toEqual({
    status: "completed",
  })
  await session.focused(home)
})

test("route factories use the session's scenario overrides", async () => {
  const store = (count: number) => ({ getState: () => ({ count }), subscribe: () => () => {} })
  const Detail = defineStoreNode({
    name: "Detail",
    type: "screen",
    store: () => store(0),
    project: (s) => s,
    actions: () => ({}),
  })
  const host = defineStoreApp({
    name: "seeded",
    screens: { Detail },
    scenarios: { seeded: { stores: { Detail: () => store(42) } } },
  })
  const session = await host.start("seeded", { sessionId: "seeded" })
  try {
    const node = await mountSessionRoute(session.runtime, Detail, {})
    expect(Detail.resolve(session.runtime, node.id)?.getSnapshot()).toEqual({ count: 42 })
  } finally {
    await session.dispose()
  }
})

test("Effect route factories provide the session's service layer", async () => {
  const session = await app.start("default", { sessionId: "route-effect" })
  try {
    const node = await mountSessionRoute(session.runtime, Counter, {})
    const resolved = liveNodeOf(session.runtime, node.id, Counter)
    expect(resolved?.getSnapshot()).toBe("1")
    session.runtime.setFocus(node.id)
    await resolved?.actions.Add()
    expect(resolved?.getSnapshot()).toBe("2")
    node.dispose()
  } finally {
    await session.dispose()
  }
})

test("store error transforms are checked, published and narrowed", async () => {
  const Failure = z.string().transform((message) => ({ _tag: "Rejected" as const, message }))
  const Store = defineStoreNode({
    name: "Failures",
    store: () => ({ getState: () => 0, subscribe: () => () => {} }),
    project: (s) => s,
    actions: (action) => ({
      Reject: action({ error: Failure, handler: (_, { fail }) => fail("try again") }),
      Parsed: action({
        input: standardInput(z.string().transform(Number)),
        handler: (value) => {
          const number: number = value
          void number
        },
      }),
    }),
  })
  const node = Store.mount(createRuntime({ sessionId: "errors" }))
  try {
    expect(await node.actions.Reject()).toMatchObject({
      status: "domain-error",
      error: { tag: "Rejected", data: { _tag: "Rejected", message: "try again" } },
    })
  } finally {
    node.dispose()
  }
})

test("URL mapping rejects duplicate targets at runtime", () => {
  const Screen = defineScreen({
    name: "URL",
    state: Schema.Number,
    params: Schema.Struct({ a: Schema.String, b: Schema.String }),
    initial: () => 0,
  })
  const params: { a: string; b: string } = { a: "id", b: "id" }
  expect(() =>
    // @ts-expect-error Adversarial runtime probe bypasses the static duplicate-target check.
    expoRoutes({ screens: { Screen } }, { Screen: { pathname: "/[id]", params } }),
  ).toThrow("targets must be unique")
})

test("tuples retain position in published navigation state", async () => {
  const Contract = defineScreen({
    name: "Tuple",
    state: Schema.Tuple([Schema.String, Schema.Number]),
    initial: () => ["a", 1],
  })
  const Tuple = Contract.implement({ actions: () => ({}) })
  const navigation = defineNavigation("tuple", { Tuple: Contract })
  const host = defineApp({
    name: "tuple",
    navigation: navigation.implement({ Tuple }, { initial: "Tuple" }),
    scenarios: { default: { layer: Layer.empty } },
    defaultScenario: "default",
  })
  const node = await (await pool.open(host)).focused(Tuple)
  const state: readonly [string, number] = await node.state()
  expect(state).toEqual(["a", 1])
})

test("scenario extensions retain app identity and independent apps do not", () => {
  const extended = app.withScenarios({ another: { layer: Layer.succeed(Amount, 2) } })
  const twice = extended.withScenarios({ third: { layer: Layer.succeed(Amount, 3) } })
  expect(definitionIdentity(extended)).toBe(definitionIdentity(app))
  expect(definitionIdentity(twice)).toBe(definitionIdentity(app))
  const independent = defineApp({
    name: app.name,
    navigation: Nav.implement({ Count: Counter }, { initial: "Count" }),
    scenarios: { default: { layer: Layer.succeed(Amount, 1) } },
    defaultScenario: "default",
  })
  expect(definitionIdentity(independent)).not.toBe(definitionIdentity(app))
})

test("navigation refusals need no action error schema", async () => {
  const { NAVIGATION_STACK_DEPTH_MAX, ErrorCode } = await import("@reflex/protocol")
  const Screen = defineScreen({ name: "Loop", state: Schema.Number, initial: () => 0 })
  const nav = defineNavigation("loop", { Loop: Screen })
  const Loop = Screen.implement({
    actions: (action) => ({ Open: action({ handler: () => nav.push("Loop") }) }),
  })
  const host = defineApp({
    name: "loop",
    navigation: nav.implement({ Loop }, { initial: "Loop" }),
    scenarios: { default: { layer: Layer.empty } },
    defaultScenario: "default",
  })
  const session = await pool.open(host)
  for (let index = 1; index < NAVIGATION_STACK_DEPTH_MAX; index++) {
    await (await session.focused(Loop)).actions.Open()
  }
  const refusal = await (await session.focused(Loop)).expectRefusal.Open()
  expect(refusal).toMatchObject({ status: "refused", code: ErrorCode.ResourceExhausted })
})

test("defineApp rejects duplicate navigator keys in retained composition metadata", () => {
  const OtherScreen = defineScreen({ name: "Other", state: Schema.Number, initial: () => 0 })
  const Other = OtherScreen.implement({ actions: () => ({}) })
  const other = defineNavigation("round3/Navigation", { Other: OtherScreen }).implement(
    { Other },
    { initial: "Other" },
  )
  const primary = Nav.implement({ Count: Counter }, { initial: "Count" })
  const root = Object.assign(Layer.merge(primary.layer, other.layer), {
    nodes: { ...primary.nodes, ...other.nodes },
    navigatorKeys: [...primary.layer.navigatorKeys, ...other.layer.navigatorKeys],
  })
  expect(() =>
    defineApp({
      name: "duplicate-keys",
      root,
      scenarios: { default: { layer: Layer.succeed(Amount, 1) } },
      defaultScenario: "default",
    }),
  ).toThrow("duplicate navigator keys")
})
