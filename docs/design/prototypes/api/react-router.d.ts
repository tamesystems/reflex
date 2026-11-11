import type { RouteObject } from "react-router"
import type * as M from "./model"
import type { HostBinding } from "./react"
import type { ValidateRoutes } from "./routes"
export type HostRouteOptions = Omit<
  RouteObject,
  "path" | "index" | "children" | "id" | "Component" | "element" | "lazy"
> &
  (
    | { Component: NonNullable<RouteObject["Component"]> }
    | { element: NonNullable<RouteObject["element"]> }
    | { lazy: NonNullable<RouteObject["lazy"]> }
  )
export interface RouterBinding<A extends M.AnyApp>
  extends HostBinding<A, import("react-router").LinkProps> {
  routes(views: { [K in M.Names<A["screens"]>]: HostRouteOptions }): RouteObject[]
}
export declare function createReflexRouter<A extends M.AnyApp, const R>(
  app: A,
  routes: R & ValidateRoutes<A, NoInfer<R>>,
): RouterBinding<A>
