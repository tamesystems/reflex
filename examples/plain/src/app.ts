import { type AppHost, createRuntime, mountStore, standardInput } from "@reflex/runtime"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

export const addSchema = z.strictObject({ by: z.int() })
export const addInput = standardInput(addSchema, z.toJSONSchema(addSchema, { io: "input" }))

/** The app still owns its state and can write it without going through Reflex. */
export const createCounterStore = () => createStore(() => ({ count: 0, token: "private-token" }))

export const plainBackend: AppHost = {
  name: "counter",
  defaultScenario: "default",
  scenarios: [{ name: "default", virtualTime: false }],
  async start(_, { sessionId, onBackgroundError }) {
    const runtime = createRuntime({
      sessionId,
      ...(onBackgroundError === undefined ? {} : { onBackgroundError }),
    })
    const store = createCounterStore()
    const node = mountStore(runtime, {
      name: "Counter",
      type: "screen",
      store,
      project: ({ count }) => ({ count }),
      actions: {
        Add: {
          input: addInput,
          handler: (input: z.infer<typeof addSchema>) => {
            store.setState(({ count }) => ({ count: count + input.by }))
          },
        },
        Reset: {
          available: ({ count }) => (count === 0 ? "Already zero" : true),
          handler: () => store.setState({ count: 0 }),
        },
      },
    })
    // Headless focus; the existing router reports the visible screen in the live app.
    runtime.setFocus(node.id)
    return { runtime, dispose: async () => node.dispose() }
  },
}
export default plainBackend
