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
