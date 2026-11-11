import type { RouteObject } from "react-router"
import type * as M from "./model"
import type { HostBinding } from "./react"
import type { ValidateRoutes } from "./routes"
export type HostRouteOptions = Pick<
  RouteObject,
  "Component" | "loader" | "action" | "errorElement" | "shouldRevalidate" | "lazy"
>
export interface RouterBinding<A extends M.AnyApp> extends HostBinding<A> {
  routes(views: { [K in M.Names<A["screens"]>]: HostRouteOptions }): RouteObject[]
}
export declare function createReflexRouter<A extends M.AnyApp, const R>(
  app: A,
  routes: R & ValidateRoutes<A, NoInfer<R>>,
): RouterBinding<A>
