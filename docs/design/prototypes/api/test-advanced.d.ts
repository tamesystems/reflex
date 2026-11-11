import type * as M from "./model"
export interface JourneyTransport {
  request(method: string, params: unknown): Promise<unknown>
  close(): Promise<void>
}
export declare function createJourneyClient<A extends M.AnyApp, K extends M.ScNames<A>>(
  app: A,
  scenario: K,
  transport: JourneyTransport,
): M.JourneyClient<A, K>

/** Raw protocol seam, including malformed requests; app callers use journeys. */
export interface ProtocolTestSession extends AsyncDisposable {
  request(method: string, params: unknown): Promise<unknown>
  events(): readonly import("@reflex/protocol").RuntimeEvent[]
}
export declare function createProtocolTestSession<A extends M.AnyApp>(
  app: A,
  options?: { scenario?: M.ScNames<A> },
): Promise<ProtocolTestSession>
/** Events recorded by the same protocol connection that backs this journey. */
export declare function protocolEvents<A extends M.AnyApp, K extends M.ScNames<A>>(
  journey: M.JourneyClient<A, K>,
): readonly import("@reflex/protocol").RuntimeEvent[]
