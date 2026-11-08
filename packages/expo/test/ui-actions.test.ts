import { expect, spyOn, test } from "bun:test"
import { defineApp, defineCapability, mount, Registry, type LiveNode } from "@reflex/effect"
import { NODE_STATE_CHARACTERS_MAX } from "@reflex/protocol"
import { waitUntil } from "@reflex/test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { send } from "../src/ui-actions.ts"

test("a resource refusal from a UI action reaches reporting", async () => {
  const Full = defineCapability({
    name: "Full",
    state: Schema.String,
    actions: (action) => ({
      Fill: action({
        handler: (_, state) => state.update(() => "x".repeat(NODE_STATE_CHARACTERS_MAX + 1)),
      }),
    }),
  })
  let live: LiveNode<string, typeof Full.actions> | undefined
  const host = defineApp({
    name: "UI",
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        live = yield* mount(Full, "before")
        const registry = yield* Registry
        registry.setFocus(live.id)
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })
  const session = await host.start("default", { sessionId: "ui" })
  const report = spyOn(console, "error").mockImplementation(() => undefined)
  try {
    if (live === undefined) {
      throw new Error("node must mount")
    }
    send(live, "Fill")
    await session.runtime.wait({ idle: true })
    await waitUntil(() => report.mock.calls.length > 0, "UI refusal to reach reporting")
    expect(JSON.stringify(report.mock.calls)).toContain("ResourceExhausted")
    expect(live.getSnapshot()).toBe("before")
  } finally {
    report.mockRestore()
    await session.dispose()
  }
})
