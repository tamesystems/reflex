import { expect, test } from "bun:test"
import { defineApp, defineNavigation, Screen } from "@reflex/effect"
import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { corePortOf } from "../src/core-port.ts"

const calls: Array<string> = []
const handlerCalled = (name: string) =>
  Effect.sync(() => {
    calls.push(name)
  })
class Home extends Screen("Home", { state: Schema.Number, initial: () => 0 }) {}
class Next extends Screen("Next", { state: Schema.Number, initial: () => 0 }) {}
const Nav = defineNavigation({ Home, Next })
const home = Home.implement({
  actions: (a) => ({
    GoBack: a({ handler: () => handlerCalled("GoBack") }),
    Navigate: a({ input: Schema.Json, handler: () => handlerCalled("Navigate") }),
  }),
})
const next = Next.implement({
  actions: (a) => ({
    GoBack: a({ handler: () => handlerCalled("GoBack") }),
    Navigate: a({ input: Schema.Json, handler: () => handlerCalled("Navigate") }),
  }),
})
const host = defineApp({
  name: "captured",
  navigation: Nav.implement([home, next], { initial: Home }),
})[APP_HOST_ADAPTER]

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
