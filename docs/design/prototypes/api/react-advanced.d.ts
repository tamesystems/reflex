import type { ComponentType } from "react"
import type { ReflexBinding } from "./react"
import type * as M from "./model"
export interface RouteAdapter {
  useLocation(): {
    key: string
    contract: object
    params: unknown
    navigationType: "POP" | "PUSH" | "REPLACE"
  }
  project?(stack: readonly object[]): void
}
export declare function createRouteAdapter<A extends M.AnyApp>(
  binding: ReflexBinding<A>,
  adapter: RouteAdapter,
): ComponentType
