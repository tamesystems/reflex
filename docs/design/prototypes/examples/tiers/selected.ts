import { Screen, defineApp } from "@reflex/effect"
import * as Schema from "effect/Schema"
export class CounterContract extends Screen("Counter", {
  state: Schema.Struct({ count: Schema.Int }),
  initial: () => ({ count: 0 }),
}) {}
export const CounterLive = CounterContract.implement({
  actions: (action) => ({
    Increment: action.reduce({ reducer: (_, s) => ({ count: s.count + 1 }) }),
  }),
})
export const selected = defineApp({ name: "counter", screens: [CounterLive] })
