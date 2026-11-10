import { type AppHost, createRuntime, mountStore } from "@reflex/runtime"

/** A background service: no screens, focus, router, framework or store library. */
const app: AppHost = {
  name: "live-counter",
  defaultScenario: "default",
  scenarios: [{ name: "default", virtualTime: false }],
  async start(_, { sessionId, onBackgroundError }) {
    const runtime = createRuntime({
      sessionId,
      ...(onBackgroundError ? { onBackgroundError } : {}),
    })
    let state = { count: 0 }
    const listeners = new Set<() => void>()
    const store = {
      getState: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    const node = mountStore(runtime, {
      name: "Counter",
      type: "service",
      store,
      project: (value) => value,
      actions: {
        Increment: {
          handler: () => {
            state = { count: state.count + 1 }
            for (const listener of listeners) {
              listener()
            }
          },
        },
      },
    })
    return { runtime, dispose: async () => node.dispose() }
  },
}
export default app
