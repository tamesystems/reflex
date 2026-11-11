import type { RuntimeEvent } from "@reflex/protocol"
import type { Client } from "@reflex/rpc"
import { createTestApp, bindAppJourney, type AuthorApp, type AnySession } from "./app-journey.ts"
import type { JourneyClientFor, Scenarios, DefaultScenario } from "./app-types.ts"
import { createRemoteTestApp, type RawTestApp } from "./test-app.ts"
export interface ProtocolTestSession extends AsyncDisposable {
  request(method: string, params: unknown): Promise<unknown>
  events(): readonly RuntimeEvent[]
}
/** Raw requests still cross serialization and the protocol's parsers. */
export async function createProtocolTestSession<A extends AuthorApp>(
  app: A,
  options: { readonly scenario?: Scenarios<A> } = {},
): Promise<ProtocolTestSession> {
  const session = await createTestApp(app, options)
  return {
    request: (method, params) => session.raw.request(method, params),
    events: () => session.raw.events,
    [Symbol.asyncDispose]: () => session.dispose(),
  }
}
export const protocolEvents = (journey: {
  readonly raw: { readonly events: readonly RuntimeEvent[] }
}): readonly RuntimeEvent[] => journey.raw.events
export interface JourneyTransport {
  request(method: string, params: unknown): Promise<unknown>
  close(): Promise<void>
  onEvent?(listener: (event: RuntimeEvent) => void): () => void
}
/** Integration plumbing for a transport that already speaks the protocol. */
export function createJourneyClient<
  A extends AuthorApp,
  K extends Scenarios<A> = DefaultScenario<A>,
>(app: A, scenario: K, transport: JourneyTransport): JourneyClientFor<A, K> {
  let closed = false
  let current: RawTestApp | undefined
  let closing: Promise<void> | undefined
  const ended = Promise.withResolvers<Error | null>()
  const request = (method: string, params: unknown) =>
    closed
      ? Promise.reject(new Error("The journey transport is closed"))
      : transport.request(method, params)
  const client: Client = {
    request: request as Client["request"],
    onEvent: (listener) => transport.onEvent?.((event) => listener(event, "journey")) ?? (() => {}),
    ended: ended.promise,
    get isEnded() {
      return closed
    },
    close() {
      closed = true
      ended.resolve(null)
      closing ??= transport.close()
      void closing.catch(() => {})
    },
  }
  const ready = createRemoteTestApp(
    client,
    undefined,
    transport.onEvent !== undefined,
    async () => {
      client.close()
      await closing
    },
  ).then((session) => {
    current = session.raw
    return bindAppJourney(app, session as unknown as AnySession, scenario) as JourneyClientFor<A, K>
  })
  // Install a handler immediately; callers observe a startup failure through their first call.
  void ready.catch(() => {})
  const invoke = async (method: string, args: unknown[]) => {
    const session = await ready
    const call = (session as unknown as Record<string, (...args: unknown[]) => unknown>)[method]
    if (call === undefined) {
      throw new Error(`Unknown journey method ${method}`)
    }
    return call(...args)
  }
  const dispose = async () => {
    try {
      await (await ready).dispose()
    } finally {
      client.close()
      await closing
    }
  }
  return {
    scenario,
    raw: {
      client,
      get state() {
        return current?.state
      },
      get events() {
        return current?.events ?? []
      },
      request,
      precondition: async (screen: string, match?: import("@reflex/protocol").Json) =>
        (await ready).raw.precondition(screen, match),
      dispatchRaw: async (action: string, input?: import("@reflex/protocol").Json) =>
        (await ready).raw.dispatchRaw(action, input),
      start: async (action: string, input?: import("@reflex/protocol").Json) =>
        (await ready).raw.start(action, input),
    },
    focused: (...args: unknown[]) => invoke("focused", args),
    node: (...args: unknown[]) => invoke("node", args),
    service: (...args: unknown[]) => invoke("service", args),
    fixture: (...args: unknown[]) => invoke("fixture", args),
    open: (...args: unknown[]) => invoke("open", args),
    back: () => invoke("back", []),
    advanceTime: (...args: unknown[]) => invoke("advanceTime", args),
    reset: (...args: unknown[]) => invoke("reset", args),
    dispose,
    [Symbol.asyncDispose]: dispose,
  } as unknown as JourneyClientFor<A, K>
}
