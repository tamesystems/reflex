/** The conformance suite's Effect app, in a module of its own so a device can load it too. */
import { defineApp, defineCapability } from "@reflex/effect"
import { mount } from "@reflex/effect/advanced"
import { Registry } from "@reflex/effect/internal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export const COUNTER_APP_MODULE = import.meta.path

const Counter = defineCapability({
  name: "Counter",
  state: Schema.Struct({ count: Schema.Int }),
  actions: (action) => ({
    Add: action({
      input: Schema.Struct({ by: Schema.Int }),
      handler: ({ by }, state) => state.update((s) => ({ count: s.count + by })),
    }),
    Reset: action({
      available: (s) => (s.count === 0 ? "Already zero" : true),
      handler: (_, state) => state.update(() => ({ count: 0 })),
    }),
  }),
})

const effectBackend = defineApp({
  name: "counter",
  defaultScenario: "default",
  root: Layer.effectDiscard(
    Effect.gen(function* () {
      const node = yield* mount(Counter, { count: 0 })
      const registry = yield* Registry
      registry.setFocus(node.id)
    }),
  ),
  scenarios: { default: { layer: Layer.empty } },
})

export default effectBackend
