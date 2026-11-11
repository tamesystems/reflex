import type * as M from "./model"
export type { NavigationCommand, NavigationRefused, StateChanged } from "./model"
export interface OwnedNode<D> {
  readonly definition: D
  dispose(): Promise<void>
}
export interface Runtime {
  readonly id: string
}
export declare function mountOwned<D extends M.AnyDef>(
  runtime: Runtime,
  definition: D,
  ...params: M.Args<M.Params<D>>
): OwnedNode<D>
export interface RouteLease {
  readonly ready: Promise<unknown>
  retain(): () => void
  retry(): Promise<unknown>
}
export interface RouteRegistry {
  acquire(contract: object, key: string, params: unknown): RouteLease
  discard(key: string): Promise<void>
  dispose(): Promise<void>
}
export declare function createRouteRegistry(
  factories: ReadonlyMap<object, (params: unknown) => Promise<unknown>>,
): RouteRegistry
