import type { InferActions, InferState, DEFINITION_IDENTITY } from "@reflex/runtime/internal"
import type { ActionOutcome } from "@reflex/runtime"
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
  : D extends readonly (infer Item extends { readonly name: string })[]
    ? Item
    : D extends Readonly<Record<string, { readonly name: string }>>
      ? D[keyof D]
      : never
export type Screens<A extends App> = Definitions<A["screens"]>
export type Services<A extends App> = A extends { services: infer V }
  ? Definitions<V>
  : A extends { nodes: infer N }
    ? Exclude<Definitions<N>, Screens<A>>
    : never
export type Table<D extends { readonly name: string }> = { [Item in D as Item["name"]]: Item }
export type Selected<T, C extends { readonly name: string }> = C["name"] extends keyof T
  ? T[C["name"]]
  : never
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
> = C extends { readonly "~reflex": unknown }
  ? [Contract<C>] extends [never]
    ? [Identity<C>] extends [Identity<Allowed>]
      ? unknown
      : Msg<`${C["name"]} is not a ${Role} of app '${N}'`>
    : [C] extends [Contract<C>]
      ? [Identity<C>] extends [Identity<Allowed>]
        ? unknown
        : Msg<`${C["name"]} is not a ${Role} of app '${N}'`>
      : Msg<`Pass the contract \`${C["name"]}\` from screens.ts, not its implementation`>
  : [Identity<C>] extends [Identity<Allowed>]
    ? unknown
    : C["name"] extends (Allowed extends { name: infer K } ? K : never)
      ? Msg<`This ${C["name"]} is a different contract from app '${N}' (${C["name"]})`>
      : Msg<`${C["name"]} is not a ${Role} of app '${N}'`>
type PublishedError<O> = O extends { status: "domain-error"; error: { data?: infer E } }
  ? E
  : O extends { status: "error"; error: infer E }
    ? E
    : never
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
type Intersect<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never
type ScreenHooks<D, Suspense extends boolean> = Intersect<
  D extends unknown
    ? (contract: Contract<D>) => Suspense extends true ? ReadyNodeView<D> : NodeView<D>
    : never
>
type Features<D> = Intersect<
  D extends unknown ? (contract: Contract<D>) => FeatureBinding<D> : never
>
type ServiceHooks<D, Suspense extends boolean> = Intersect<
  D extends unknown
    ? (definition: D) => Suspense extends true ? ReadyNodeView<D> : NodeView<D>
    : never
>

// Precompute concrete overloads once. The generic fallback preserves union contracts
// and diagnostics without expanding the full definition table for ordinary calls.
export type Hook<A extends App, T, Suspense extends boolean> = <
  const C extends { readonly name: string },
>(
  contract: C & NoInfer<Member<C, Contract<Selected<T, C>>, A["name"]>>,
) => Suspense extends true ? ReadyNodeView<Selected<T, C>> : NodeView<Selected<T, C>>
type ServiceHookFallback<A extends App, D, Suspense extends boolean> = <
  C extends { readonly name: string },
>(
  definition: C &
    NoInfer<
      Member<C, Selected<Table<Extract<D, { readonly name: string }>>, C>, A["name"], "service">
    >,
) => Suspense extends true ? ReadyNodeView<C> : NodeView<C>

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
  withApp<B extends Pick<A, "name" | "screens" | "services"> & App>(app: B): ReflexBinding<B>
  Provider: ComponentType<{
    app?: Pick<A, "name" | "screens" | "services">
    scenario?: Scenario<A>
    bridge?: Bridge | undefined
    fallback?: ReactNode
    onBackgroundError?: (error: unknown) => void
    children?: ReactNode
  }>
  useScreen: ScreenHooks<Screens<A>, true> & Hook<A, T, true>
  useScreenStatus: ScreenHooks<Screens<A>, false> & Hook<A, T, false>
  useService: ServiceHooks<Services<A>, true> & ServiceHookFallback<A, Services<A>, true>
  useServiceStatus: ServiceHooks<Services<A>, false> & ServiceHookFallback<A, Services<A>, false>
  from: Features<Screens<A>> &
    (<const C extends { readonly name: string }>(
      contract: C & NoInfer<Member<C, Contract<Selected<T, C>>, A["name"]>>,
    ) => FeatureBinding<Selected<T, C>>)
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
