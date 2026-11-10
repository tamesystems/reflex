import type { Runtime } from "./runtime.ts"

export interface OwnedRoute {
  readonly id: import("@reflex/protocol").NodeId
  dispose(): void
}
type Factory = (params: unknown) => OwnedRoute | Promise<OwnedRoute>
const factories = new WeakMap<Runtime, ReadonlyMap<object, Factory>>()
/** Each session owns the services and scenario overrides used to build its routes. */
export const registerRouteFactories = (
  runtime: Runtime,
  entries: ReadonlyMap<object, Factory>,
): void => {
  factories.set(runtime, entries)
}
export const mountSessionRoute = (
  runtime: Runtime,
  definition: object,
  params: unknown,
): OwnedRoute | Promise<OwnedRoute> => {
  const mount = factories.get(runtime)?.get(definition)
  if (mount === undefined) {
    throw new Error("The route definition is not registered in this session's app")
  }
  return mount(params)
}
