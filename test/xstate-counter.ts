/** Test-only actor backend: deliberately no Effect or production XState dependency. */
import { ErrorCode, ProtocolError } from "@reflex/protocol"
import { type AppHost, createRuntime, type NodeAdapter, type Runtime } from "@reflex/runtime"
import { assign, createActor, fromPromise, setup } from "xstate"

type CounterEvent = { type: "Add"; by: number } | { type: "Reset" } | { type: "Load" }
export type LoadCount = (signal: AbortSignal) => Promise<number>

const counterMachine = setup({
  types: {
    context: {} as { count: number; load: LoadCount },
    events: {} as CounterEvent,
    input: {} as { load: LoadCount },
  },
  actors: {
    load: fromPromise<number, { load: LoadCount }>(({ input, signal }) => input.load(signal)),
  },
}).createMachine({
  context: ({ input }) => ({ count: 0, load: input.load }),
  initial: "ready",
  states: {
    ready: {
      on: {
        Add: { actions: assign({ count: ({ context, event }) => context.count + event.by }) },
        Reset: {
          guard: ({ context }) => context.count !== 0,
          actions: assign({ count: 0 }),
        },
        Load: "loading",
      },
    },
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ load: context.load }),
        onDone: { target: "ready", actions: assign({ count: ({ event }) => event.output }) },
        onError: "ready",
      },
    },
  },
})

type CounterActor = ReturnType<typeof createCounterActor>
const createCounterActor = (load: LoadCount) => createActor(counterMachine, { input: { load } })

const emptyInputSchema = { type: "object", additionalProperties: false } as const
const addInputSchema = {
  type: "object",
  properties: { by: { type: "integer" } },
  required: ["by"],
  additionalProperties: false,
} as const

const eventOf = (action: string, input: unknown): CounterEvent => {
  const object = typeof input === "object" && input !== null && !Array.isArray(input)
  if (action === "Add") {
    if (
      !object ||
      !("by" in input) ||
      !Number.isInteger(input.by) ||
      Object.keys(input).length !== 1
    ) {
      throw new ProtocolError(ErrorCode.InvalidInput, "Expected exactly one integer property: by")
    }
    return { type: "Add", by: Number(input.by) }
  }
  if (action !== "Reset" && action !== "Load") {
    throw new ProtocolError(ErrorCode.ActionNotFound, `Unknown action: ${action}`)
  }
  if (input !== undefined && (!object || Object.keys(input).length !== 0)) {
    throw new ProtocolError(ErrorCode.InvalidInput, "Expected an empty object or omitted input")
  }
  return { type: action }
}

const availability = (actor: CounterActor, event: CounterEvent) =>
  actor.getSnapshot().can(event)
    ? ({ available: true } as const)
    : ({ available: false, unavailableReason: "No enabled transition" } as const)

const adapterOf = (runtime: Runtime, actor: CounterActor): NodeAdapter => ({
  id: runtime.nextId("screen", "Counter"),
  type: "screen",
  name: "Counter",
  // Project public JSON, never the snapshot's actor refs, functions, or internal machinery.
  snapshot: () => ({ count: actor.getSnapshot().context.count }),
  actions: () => ({
    // Add has no input-dependent guard: a representative valid event suffices here.
    Add: { ...availability(actor, { type: "Add", by: 0 }), inputSchema: addInputSchema },
    Reset: { ...availability(actor, { type: "Reset" }), inputSchema: emptyInputSchema },
    Load: { ...availability(actor, { type: "Load" }), inputSchema: emptyInputSchema },
  }),
  prepare(action, input) {
    const event = eventOf(action, input)
    return () => {
      actor.send(event)
      // Completion means this event's synchronous transition, not invoked child work.
      return { done: Promise.resolve({ status: "completed" }), cancel: () => undefined }
    }
  },
  subscribe(listener) {
    const subscription = actor.subscribe(() => listener())
    return () => subscription.unsubscribe()
  },
})

export const createCounterSession = (sessionId: string, load: LoadCount = async () => 10) => {
  const runtime = createRuntime({ sessionId })
  const actor = createCounterActor(load)
  actor.start()
  const adapter = adapterOf(runtime, actor)
  const unregister = runtime.register(adapter)
  runtime.setFocus(adapter.id)
  return {
    runtime,
    actor,
    async dispose() {
      unregister()
      actor.stop()
    },
  }
}

export const xstateBackend: AppHost = {
  name: "counter",
  defaultScenario: "default",
  scenarios: [{ name: "default", virtualTime: false }],
  async start(_, { sessionId }) {
    return createCounterSession(sessionId)
  },
}
