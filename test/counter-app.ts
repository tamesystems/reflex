/** The conformance suite's Effect app, loadable by the live device worker too. */
import { defineApp, defineNavigation, Screen } from "@reflex/effect"
import { APP_HOST_ADAPTER, type AppHost } from "@reflex/runtime/internal"
import * as Schema from "effect/Schema"

export const COUNTER_APP_MODULE = import.meta.path

const Counter = Screen.define("Counter", {
  state: Schema.Struct({ count: Schema.Int }),
  initial: () => ({ count: 0 }),
  actions: (action) => ({
    Add: action.reduce({
      input: Schema.Struct({ by: Schema.Int }),
      reducer: ({ by }, state) => ({ count: state.count + by }),
    }),
    Reset: action.reduce({
      available: (s) => (s.count === 0 ? "Already zero" : true),
      reducer: () => ({ count: 0 }),
    }),
  }),
})
const Nav = defineNavigation({ Counter })
export const app = defineApp({
  name: "counter",
  navigation: Nav.implement([Counter], { initial: Counter }),
})
// Workers/controllers consume the infrastructure host; authors compose the descriptor above.
export default (app as unknown as { readonly [APP_HOST_ADAPTER]: AppHost })[APP_HOST_ADAPTER]
