import type { ComponentType, ReactNode, ReactElement, ComponentProps } from "react"
import type * as M from "./model"
import type { Bridge, BackgroundReporter } from "./live"
export type ActionView<F> = F extends (...args: infer I) => Promise<infer O>
  ? {
      run(...args: I): Promise<O>
      readonly available: boolean
      readonly pending: boolean
      readonly reason: string | null
    }
  : never
export type { NodeView, ReadyNodeView, ActionViews } from "./model"
export interface SessionControls<A extends M.AnyApp> {
  readonly scenario: string
  readonly status: "starting" | "live" | "failed" | "closed"
  reset<K extends M.ScNames<A>>(scenario: K): Promise<SessionControls<A>>
}
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
    bridge?: "development" | Bridge | undefined
    fallback?: ReactNode
    onBackgroundError?: BackgroundReporter
    children?: ReactNode
  }>
  useScreen: DiagnosticHook<A, Table, true>
  useScreenStatus: DiagnosticHook<A, Table, false>
  useService<D extends { readonly name: string }>(
    definition: D & M.Member<NoInfer<D>, A["services"], A["name"], "service">,
  ): M.NodeView<D>
  from<D extends M.AnyDef>(definition: D): FeatureBinding<D>
  useSession(): SessionControls<A>
}
export declare function createReflex<A extends M.AnyApp>(app: A): ReflexBinding<A>
export interface HostBinding<A extends M.AnyApp, HostLinkProps = ComponentProps<"a">>
  extends ReflexBinding<A> {
  href(...args: M.RouteArgs<M.Contracts<A["screens"]>, true>): string
  Link(
    props: LinkProps<M.Contracts<A["screens"]>> &
      Omit<HostLinkProps, "to" | "href" | "params" | "asChild">,
  ): ReactElement
}
type LinkProps<C> = C extends unknown
  ? {
      to: C
      children?: ReactNode
      replace?: boolean
      className?: string
    } & (keyof M.URLParams<C> extends never ? { params?: never } : { params: M.URLParams<C> })
  : never

export interface FeatureBinding<D> {
  useScreen(): M.ReadyNodeView<D>
  useScreenStatus(): M.NodeView<D>
  useNodeState<Selected>(selector: (state: M.State<D>) => Selected): Selected
  useAction<K extends keyof M.Actions<D>>(name: K): M.ActionViews<M.Actions<D>>[K]
}
