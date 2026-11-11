import type { ComponentType, ReactNode, ReactElement } from "react"
import type * as M from "./model"
import type { Bridge, BackgroundReporter } from "./live"
export type { NodeView, ReadyNodeView, ActionViews } from "./model"
export interface SessionControls<A extends M.AnyApp> {
  readonly scenario: string
  readonly status: "starting" | "live" | "failed" | "closed"
  reset<K extends M.ScNames<A>>(scenario: K): Promise<SessionControls<A>>
  forScenario<B extends M.AnyApp, K extends M.ScNames<B>>(
    app: B,
    scenario: K,
  ): M.JourneyClient<B, K, "outcome"> | undefined
}
type UnionToIntersection<U> = (U extends unknown ? (v: U) => void : never) extends (
  v: infer I,
) => void
  ? I
  : never
type ScreenHook<Table, Suspense extends boolean> = UnionToIntersection<
  {
    [K in keyof Table]: (
      contract: { readonly name: K } & M.ContractArg<M.Contracts<Table[K]>>,
    ) => Suspense extends true ? M.ReadyNodeView<Table[K]> : M.NodeView<Table[K]>
  }[keyof Table]
>
type DiagnosticHook<A extends M.AnyApp, Table, Suspense extends boolean> = <
  const C extends { readonly name: string },
>(
  contract: C & NoInfer<M.MemberFromTable<Table, C, A["name"]>>,
) => Suspense extends true
  ? M.ReadyNodeView<M.SelectedFromTable<Table, C>>
  : M.NodeView<M.SelectedFromTable<Table, C>>
export interface ReflexBinding<A extends M.AnyApp, Table = M.DefinitionMap<A["screens"]>> {
  Provider: ComponentType<{
    app?: {
      readonly name: A["name"]
      readonly screens: A["screens"]
      readonly services: A["services"]
    }
    bridge?: Bridge | undefined
    fallback?: ReactNode
    onBackgroundError?: BackgroundReporter
    children?: ReactNode
  }>
  useScreen: ScreenHook<Table, false> & DiagnosticHook<A, Table, false>
  useScreenSuspense: ScreenHook<Table, true> & DiagnosticHook<A, Table, true>
  useService<D extends { readonly name: string }>(
    definition: D & M.Member<NoInfer<D>, A["services"], A["name"], "service">,
  ): M.NodeView<D>
  useSession(): SessionControls<A>
}
export declare function createReflex<A extends M.AnyApp>(app: A): ReflexBinding<A>
export interface HostBinding<A extends M.AnyApp> extends ReflexBinding<A> {
  href(...args: M.RouteArgs<M.Contracts<A["screens"]>, true>): string
  Link(props: LinkProps<M.Contracts<A["screens"]>>): ReactElement
}
type LinkProps<C> = C extends unknown
  ? {
      to: C
      children?: ReactNode
      replace?: boolean
      className?: string
    } & (keyof M.URLParams<C> extends never ? { params?: never } : { params: M.URLParams<C> })
  : never
