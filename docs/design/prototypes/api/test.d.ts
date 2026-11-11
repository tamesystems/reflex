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

export declare function explore<A extends M.AnyApp, K extends M.ScNames<A> = M.DefaultOf<A>>(
  app: A,
  options: {
    scenario?: K
    steps?: number
    seed?: number
    invariant(session: M.JourneyClient<A, K>): Promise<void>
    knownInputs?: {
      [N in M.Names<A["screens"] | A["services"]>]?: {
        [Action in keyof M.Actions<
          M.Selected<A["screens"] | A["services"], { name: N }>
        >]?: M.Actions<M.Selected<A["screens"] | A["services"], { name: N }>>[Action] extends {
          input: infer I
        }
          ? readonly I[]
          : never
      }
    }
  },
): Promise<void>
