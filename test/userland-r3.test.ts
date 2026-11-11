import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { afterEach, expect, test } from "bun:test"
import {
  defineApp,
  defineNavigation,
  defineFixture,
  Screen as screenContract,
} from "@reflex/effect"
import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
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
const Count = screenContract("Count", { state: Schema.NumberFromString, initial: () => 1 })
const Nav = defineNavigation({ Count }, { key: "round3/Navigation" })
const Counter = Count.implement({
  actions: (action) => ({
    Add: action({
      handler: (_, { state }) =>
        Effect.flatMap(Amount, (amount) => state.update((n) => n + amount)),
    }),
  }),
})
const authored = defineApp({
  name: "round3",
  navigation: Nav.implement([Counter], { initial: Count }),
  scenarios: { default: { layer: Layer.succeed(Amount, 1) } },
  defaultScenario: "default",
})

const app = authored

test("navigation preserves transformed state and contract lookup across implementations", async () => {
  const session = await pool.open(app)
  const count = await session.focused(Counter)
  expect(await count.state()).toBe("1")
  await count.actions.Add()
  expect(await count.state()).toBe("2")
  const live = await app[APP_HOST_ADAPTER].start("default", { sessionId: "identity" })
  try {
    const second = Count.implement({ actions: () => ({}) })
    const id = live.runtime.focus
    expect(id).not.toBeNull()
    if (id === null) {
      throw new Error("Expected focus")
    }
    expect(second.resolve(live.runtime, id)).toBeDefined()
  } finally {
    await live.dispose()
  }
})

test("composition rejects foreign contracts and duplicate implementations immediately", () => {
  const clone = screenContract("Count", {
    state: Schema.NumberFromString,
    initial: () => 1,
  }).implement({ actions: () => ({}) })
  expect(() => Nav.implement([clone], { initial: Count })).toThrow(
    "must implement its registered contract",
  )
  // @ts-expect-error Adversarial runtime duplicate probe.
  expect(() => Nav.implement([Counter, Counter], { initial: Count })).toThrow(
    "declared more than once",
  )
  const fixture = defineFixture({
    name: "Count",
    state: Schema.Number,
    initial: () => 0,
    actions: () => ({}),
  })
  expect(() =>
    defineApp({
      name: "duplicate-name",
      navigation: Nav.implement([Counter], { initial: Count }),
      fixtures: [fixture],
      scenarios: { default: { layer: Layer.succeed(Amount, 1) } },
    }),
  ).toThrow("Count is declared more than once")
  expect(() =>
    defineApp({
      name: "conflict",
      navigation: Nav.implement([Counter], { initial: Count }),
      screens: [clone],
      scenarios: { default: { layer: Layer.succeed(Amount, 1) } },
    } as never),
  ).toThrow("Choose navigation or screens")
})

test("journey membership rejects an independent same-name definition", async () => {
  const session = await pool.open(app)
  const clone = screenContract("Count", {
    state: Schema.NumberFromString,
    initial: () => 1,
  }).implement({
    actions: (action) => ({
      Add: action({ handler: (_, { state }) => state.update((n) => n + 1) }),
    }),
  })
  await expect(session.focused(clone)).rejects.toThrow("does not belong")
})

test("un-narrowed journey state follows legitimate union transitions", async () => {
  const Contract = screenContract("Union", {
    state: Schema.Union([Schema.TaggedStruct("one", {}), Schema.TaggedStruct("two", {})]),
    initial: () => ({ _tag: "one" }),
  })
  const Union = Contract.implement({
    actions: (action) => ({
      Next: action({ handler: (_, { state }) => state.update(() => ({ _tag: "two" })) }),
    }),
  })
  const navigation = defineNavigation({ Union: Contract })
  const host = defineApp({
    name: "union",
    navigation: navigation.implement([Union], { initial: Contract }),
    scenarios: { default: { layer: Layer.empty } },
    defaultScenario: "default",
  })
  const session = await pool.open(host)
  const node = await session.focused(Union)
  const focused = await session.focused(Union)
  const narrowed = await session.focused(Union, { _tag: "one" })
  await node.actions.Next()
  expect(await node.state()).toEqual({ _tag: "two" })
  expect(await focused.state()).toEqual({ _tag: "two" })
  await expect(narrowed.state()).rejects.toThrow("changed state tag")
})

test("back completes the calling action before retiring its screen", async () => {
  const Home = screenContract("Home", { state: Schema.Number, initial: () => 0 })
  const Detail = screenContract("Detail", { state: Schema.Number, initial: () => 0 })
  const nav = defineNavigation({ Home, Detail })
  const home = Home.implement({
    actions: (action) => ({ Open: action.navigates({ handler: () => nav.push(Detail) }) }),
  })
  const detail = Detail.implement({
    actions: (action) => ({ SaveAndClose: action.navigates({ handler: () => nav.back }) }),
  })
  const host = defineApp({
    name: "return",
    navigation: nav.implement([home, detail], { initial: Home }),
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
    screens: [Detail],
    scenarios: { seeded: { stores: [Detail.withStore(() => store(42))] } },
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
  const session = await app[APP_HOST_ADAPTER].start("default", { sessionId: "route-effect" })
  try {
    const node = await mountSessionRoute(session.runtime, Counter, {})
    const resolved = Counter.resolve(session.runtime, node.id)
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
  const Screen = screenContract("URL", {
    state: Schema.Number,
    params: { a: Schema.String, b: Schema.String },
    initial: () => 0,
  })
  const params: { a: string; b: string } = { a: "id", b: "id" }
  expect(() =>
    // @ts-expect-error Adversarial runtime probe bypasses the static duplicate-target check.
    expoRoutes({ screens: { Screen } }, { Screen: { pathname: "/[id]", params } }),
  ).toThrow("targets must be unique")
})

test("tuples retain position in published navigation state", async () => {
  const Contract = screenContract("Tuple", {
    state: Schema.Tuple([Schema.String, Schema.Number]),
    initial: () => ["a", 1],
  })
  const Tuple = Contract.implement({ actions: () => ({}) })
  const navigation = defineNavigation({ Tuple: Contract })
  const host = defineApp({
    name: "tuple",
    navigation: navigation.implement([Tuple], { initial: Contract }),
    scenarios: { default: { layer: Layer.empty } },
    defaultScenario: "default",
  })
  const node = await (await pool.open(host)).focused(Tuple)
  const state: readonly [string, number] = await node.state()
  expect(state).toEqual(["a", 1])
})

test("scenario extensions retain app identity and independent apps do not", () => {
  const another = { another: { layer: Layer.succeed(Amount, 2) } }
  const third = { third: { layer: Layer.succeed(Amount, 3) } }
  const extended = authored.withScenarios<typeof another>(another)
  const twice = extended.withScenarios<typeof third>(third)
  expect(definitionIdentity(extended)).toBe(definitionIdentity(authored))
  expect(definitionIdentity(twice)).toBe(definitionIdentity(authored))
  const independent = defineApp({
    name: app.name,
    navigation: Nav.implement([Counter], { initial: Count }),
    scenarios: { default: { layer: Layer.succeed(Amount, 1) } },
    defaultScenario: "default",
  })
  expect(definitionIdentity(independent)).not.toBe(definitionIdentity(authored))
})

test("navigation refusals need no action error schema", async () => {
  const { NAVIGATION_STACK_DEPTH_MAX } = await import("@reflex/protocol")
  const Screen = screenContract("Loop", { state: Schema.Number, initial: () => 0 })
  const nav = defineNavigation({ Loop: Screen })
  const Loop = Screen.implement({
    actions: (action) => ({ Open: action.navigates({ handler: () => nav.push(Screen) }) }),
  })
  const host = defineApp({
    name: "loop",
    navigation: nav.implement([Loop], { initial: Screen }),
    scenarios: { default: { layer: Layer.empty } },
    defaultScenario: "default",
  })
  const session = await pool.open(host)
  for (let index = 1; index < NAVIGATION_STACK_DEPTH_MAX; index++) {
    await (await session.focused(Loop)).actions.Open()
  }
  const refusal = await (await session.focused(Loop)).actions.Open.expectRefusal()
  expect(refusal).toMatchObject({ status: "refused", reason: expect.any(String) })
})

test("navigation rejects mismatched contract keys before composition", () => {
  const Other = screenContract("Other", { state: Schema.Number, initial: () => 0 })
  expect(() => defineNavigation({ Wrong: Other } as never)).toThrow(
    "Navigation key Wrong must match contract name Other",
  )
})
