import { Screen, defineApp } from "@reflex/effect"
import * as Schema from "effect/Schema"

export const Counter = Screen.define("Counter", {
  state: Schema.Struct({ count: Schema.Int }),
  initial: () => ({ count: 0 }),
  actions: (action) => ({
    Increment: action.reduce({ reducer: (_, s) => ({ count: s.count + 1 }) }),
  }),
})
export const app = defineApp({ name: "counter", screens: [Counter] })
