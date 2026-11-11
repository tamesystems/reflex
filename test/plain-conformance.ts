import { defineStoreApp } from "@reflex/runtime"
import { openSessionRoute, type AppHost } from "@reflex/runtime/internal"
import { Counter } from "../examples/plain/src/app.ts"

const app = defineStoreApp({ name: "counter", screens: [Counter] })
/** The test host opens the screen that a router would open in a UI. */
const backend: AppHost = {
  ...app,
  async start(scenario, options) {
    const session = await app.start(scenario, options)
    try {
      await openSessionRoute(app, session, "Counter", {})
      return session
    } catch (error) {
      await session.dispose()
      throw error
    }
  },
}
export default backend
