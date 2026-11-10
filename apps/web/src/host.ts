import { type AppHost, createRuntime, mountStore, type Runtime } from "@reflex/runtime"

// Entries belong to the application, not to a Reflex navigation stack. Retain them
// until reset so browser forward restores both the entry's node and its state.
const entries = new WeakMap<Runtime, Map<string, ReturnType<typeof mountEntry>>>()
const mountEntry = (runtime: Runtime, name: string) => {
  let state = { count: 0 }
  const listeners = new Set<() => void>()
  const add = () => {
    state = { count: state.count + 1 }
    for (const listener of listeners) {
      listener()
    }
  }
  const node = mountStore(runtime, {
    name,
    type: "screen",
    store: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    project: (value) => value,
    actions: { Increment: { handler: add } },
  })
  return { id: node.id, add, dispose: node.dispose }
}
export type Entry = ReturnType<typeof mountEntry>

const cacheOf = (runtime: Runtime) => {
  const cache = entries.get(runtime)
  if (cache === undefined) {
    throw new Error("No entry owner for this session")
  }
  return cache
}

/** The entry already mounted for a history key, if any. Pure, so safe during render. */
export const existingEntry = (runtime: Runtime, key: string): Entry | null =>
  cacheOf(runtime).get(key) ?? null

/**
 * Mounts the entry for a history key, once. Call it from an effect, never during render:
 * a render React abandons would otherwise leave a node the CLI can see and nothing shows.
 */
export const entryFor = (runtime: Runtime, key: string, name: string): Entry => {
  const cache = cacheOf(runtime)
  let entry = cache.get(key)
  if (entry === undefined) {
    entry = mountEntry(runtime, name)
    cache.set(key, entry)
  }
  return entry
}
export const host: AppHost = {
  name: "router-counter",
  defaultScenario: "default",
  scenarios: [{ name: "default", virtualTime: false }],
  async start(_, { sessionId, onBackgroundError }) {
    const runtime = createRuntime({
      sessionId,
      ...(onBackgroundError ? { onBackgroundError } : {}),
    })
    const cache = new Map<string, ReturnType<typeof mountEntry>>()
    entries.set(runtime, cache)
    return {
      runtime,
      dispose: async () => {
        for (const entry of cache.values()) {
          entry.dispose()
        }
      },
    }
  },
}
