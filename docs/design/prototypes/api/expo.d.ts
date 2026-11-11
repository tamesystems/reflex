import type * as M from "./model"
import type { HostBinding } from "./react"
import type { ValidateRoutes } from "./routes"
export declare function createReflexExpo<A extends M.AnyApp, const R>(
  app: A,
  routes: R & ValidateRoutes<A, NoInfer<R>>,
): HostBinding<A>
