import { expect, spyOn, test } from "bun:test"
import { defineApp, defineNavigation, Screen } from "@reflex/effect"
import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
import { NODE_STATE_CHARACTERS_MAX } from "@reflex/protocol"
import { waitUntil } from "../../../test/support.ts"
import * as Schema from "effect/Schema"
import { send } from "../src/ui-actions.ts"

test("a resource refusal from a UI action reaches reporting", async () => {
  const Full = Screen.define("Full", {
    initial: () => "before",
    state: Schema.String,
    actions: (action) => ({
      Fill: action({
        handler: (_, { state }) => state.update(() => "x".repeat(NODE_STATE_CHARACTERS_MAX + 1)),
      }),
    }),
  })
  const Nav = defineNavigation({ Full })
  const host = defineApp({ name: "UI", navigation: Nav.implement([Full], { initial: Full }) })
  const session = await host[APP_HOST_ADAPTER].start("default", { sessionId: "ui" })
  const live = Full.resolve(session.runtime)
  const report = spyOn(console, "error").mockImplementation(() => undefined)
  try {
    if (live === undefined) {
      throw new Error("node must mount")
    }
    void send(live, "Fill")
    await session.runtime.wait({ idle: true })
    await waitUntil(() => report.mock.calls.length > 0, "UI refusal to reach reporting")
    expect(JSON.stringify(report.mock.calls)).toContain("ResourceExhausted")
    expect(live.getSnapshot()).toBe("before")
  } finally {
    report.mockRestore()
    await session.dispose()
  }
})
