import type {
  ConsumerDefinition,
  InferActions,
  InferState,
  DEFINITION_IDENTITY,
} from "@reflex/runtime/internal"
import type { ActionOutcome } from "@reflex/runtime/advanced"
import type { ReactNode, ComponentType, ComponentProps, ReactElement } from "react"
import type { Bridge } from "./react.tsx"

export interface App {
  readonly name: string
  readonly screens?: unknown
  readonly nodes?: unknown
  readonly services?: unknown
  readonly scenarioNames?: readonly string[]
  readonly defaultScenario: string
}
export type Definitions<D> = D extends { readonly name: string }
  ? D
  : D extends readonly unknown[]
    ? D[number]
    : D[keyof D]
export type Screens<A extends App> = Definitions<A["screens"]>
export type Services<A extends App> = A extends { services: infer V }
  ? Definitions<V>
  : A extends { nodes: infer N }
    ? Exclude<Definitions<N>, Screens<A>>
    : never
export type Table<D> = { [Item in Extract<D, { readonly name: string }> as Item["name"]]: Item }
export type Selected<T, C extends { readonly name: string }> = T[C["name"] & keyof T]
type Meta<D> = D[keyof D & symbol]
export type Contract<D> = D extends unknown
  ? Extract<Meta<D>, { contract: unknown }> extends infer M
    ? [M] extends [never]
      ? D
      : M extends { contract: infer C }
        ? C
        : D
    : never
  : never
export type URLParams<D> =
  Extract<Meta<D>, { encodedParams: unknown }> extends infer M
    ? [M] extends [never]
      ? D extends { params: { Encoded: infer P } }
        ? P
        : Record<never, never>
      : M extends { encodedParams: infer P }
        ? P
        : never
    : never
export type Msg<S extends string> = { readonly [K in S]: never } & {
  readonly "Reflex type error": S
}
// Constructors are checked through their static contract surface; no union scan occurs at
// a hook site. The name-indexed table is instantiated once when binding the app.
type Identity<C> = C extends abstract new (
  ...args: never[]
) => object
  ? C
  : C extends { readonly [DEFINITION_IDENTITY]: infer I }
    ? { readonly name: C extends { name: infer N } ? N : never; readonly [DEFINITION_IDENTITY]: I }
    : C
export type Member<
  C extends { readonly name: string },
  Allowed,
  N extends string,
  Role extends string = "screen",
> = [Identity<C>] extends [Identity<Allowed>]
  ? unknown
  : C["name"] extends (Allowed extends { name: infer K } ? K : never)
    ? Msg<`This ${C["name"]} is a different contract from app '${N}''s ${C["name"]}`>
    : Msg<`${C["name"]} is not a ${Role} of app '${N}'`>
type PublishedError<O> = O extends { status: "domain-error"; error: { data?: infer E } } ? E : never
export type ActionView<F> = F extends (...args: infer I) => Promise<infer O>
  ? {
      run(...args: I): Promise<ActionOutcome<PublishedError<O>>>
      readonly available: boolean
      readonly pending: boolean
      readonly reason: string | null
    }
  : never
export type ActionViews<A> = { readonly [K in keyof A]: ActionView<A[K]> }
export type ReadyNodeView<D> = {
  readonly status: "ready"
  readonly state: InferState<D>
  readonly actions: { readonly [K in keyof InferActions<D>]: ActionView<InferActions<D>[K]> }
}
export type NodeView<D> =
  | ReadyNodeView<D>
  | { readonly status: "pending"; readonly state: null; readonly actions: null }
  | {
      readonly status: "error"
      readonly state: null
      readonly actions: null
      readonly error: Error
      retry(): Promise<void>
    }
export type Hook<A extends App, T, Suspense extends boolean> = <
  const C extends { readonly name: string },
>(
  contract: C & NoInfer<Member<C, Contract<Selected<T, C>>, A["name"]>>,
) => Suspense extends true ? ReadyNodeView<Selected<T, C>> : NodeView<Selected<T, C>>
export type Scenario<A> = A extends { scenarioNames: readonly (infer N extends string)[] }
  ? N
  : string
export interface SessionControls<A> {
  readonly scenario: Scenario<A>
  readonly status: "starting" | "live" | "failed" | "closed"
  reset(scenario: Scenario<A>): Promise<SessionControls<A>>
}
export interface FeatureBinding<D> {
  useScreen(): ReadyNodeView<D>
  useScreenStatus(): NodeView<D>
  useNodeState<S>(selector: (state: InferState<D>) => S): S
  useAction<K extends keyof InferActions<D> & string>(name: K): ActionView<InferActions<D>[K]>
}
export interface ReflexBinding<A extends App, T = Table<Screens<A>>> {
  Provider: ComponentType<{
    app?: Pick<A, "name" | "screens" | "services">
    scenario?: Scenario<A>
    bridge?: "development" | Bridge | undefined
    fallback?: ReactNode
    onBackgroundError?: (error: unknown) => void
    children?: ReactNode
  }>
  useScreen: Hook<A, T, true>
  useScreenStatus: Hook<A, T, false>
  useScreenSuspense: Hook<A, T, true>
  useService<D extends { readonly name: string }>(
    definition: D & NoInfer<Member<D, Selected<Table<Services<A>>, D>, A["name"], "service">>,
  ): NodeView<D>
  from<D extends ConsumerDefinition>(definition: D): FeatureBinding<D>
  useSession(): SessionControls<A>
}

export interface HostBinding<A extends App, HostLinkProps = ComponentProps<"a">>
  extends ReflexBinding<A> {
  href(...args: RouteArgs<Contract<Screens<A>>>): string
  Link(props: BoundLinkProps<Contract<Screens<A>>, HostLinkProps>): ReactElement
}
type RouteArgs<C> = C extends unknown
  ? [contract: C, ...params: keyof URLParams<C> extends never ? [] : [params: URLParams<C>]]
  : never
type BoundLinkProps<C, HostLinkProps> = C extends unknown
  ? {
      to: C
      children?: ReactNode
      replace?: boolean
      className?: string
    } & (keyof URLParams<C> extends never ? { params?: never } : { params: URLParams<C> }) &
      Omit<HostLinkProps, "to" | "href" | "params" | "asChild">
  : never
