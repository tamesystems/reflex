import { expect, test } from "bun:test"
import { defineApp, defineCapability, NoParams } from "@reflex/effect"
import { defineNavigationFactories, mountOwned as mount } from "@reflex/effect/internal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { corePortOf } from "../src/core-port.ts"

const calls: Array<string> = []
const Nav = defineNavigationFactories("test/Captured", { Home: NoParams, Next: NoParams })
const handlerCalled = (name: string) =>
  Effect.sync(() => {
    calls.push(name)
  })
const Captures = defineCapability({
  name: "Captures",
  state: Schema.Struct({}),
  actions: (action) => ({
    GoBack: action({ handler: () => handlerCalled("GoBack") }),
    Navigate: action({ input: Schema.Unknown, handler: () => handlerCalled("Navigate") }),
  }),
})
const host = defineApp({
  name: "captured",
  defaultScenario: "default",
  root: Nav.layer({
    initial: { route: "Home", params: {} },
    screens: { Home: () => mount(Captures, {}), Next: () => mount(Captures, {}) },
  }),
  scenarios: { default: { layer: Layer.empty } },
})

test("the router's back and navigate reach navigation, whatever a screen calls its actions", async () => {
  calls.length = 0
  const session = await host.start("default", { sessionId: "s" })
  try {
    const core = corePortOf(session)
    await core.navigate({ route: "Next", params: {} })
    expect(core.readStack().map(({ route }) => route)).toEqual(["Home", "Next"])
    await core.goBack()
    expect(core.readStack().map(({ route }) => route)).toEqual(["Home"])
    expect(calls).toEqual([])
  } finally {
    await session.dispose()
  }
})
