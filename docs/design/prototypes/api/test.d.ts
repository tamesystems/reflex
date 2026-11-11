import type * as M from "./model"
export type {
  JourneyClientFor,
  JourneyClient,
  JourneyNode,
  JourneyOperation,
  StateMatch,
  Matched,
  Includes,
} from "./model"
export declare function includes<E>(...items: ReadonlyArray<Partial<NoInfer<E>>>): M.Includes<E>
export declare function createTestApp<A extends M.AnyApp, K extends M.ScNames<A> = M.DefaultOf<A>>(
  app: A,
  options?: { scenario?: K; timeoutMs?: number },
): Promise<M.JourneyClient<A, K>>
export declare function connectJourney<A extends M.AnyApp, K extends M.ScNames<A> = M.DefaultOf<A>>(
  app: A,
  options: { target: "headless" | "device"; scenario?: K; timeoutMs?: number },
): Promise<M.JourneyClient<A, K>>
export declare function createTestAppPool(): {
  open: typeof createTestApp
  disposeAll(): Promise<void>
}
