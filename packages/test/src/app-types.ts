import type {
  ConsumerDefinition,
  InferState,
  InferActions,
  DEFINITION_IDENTITY,
} from "@reflex/runtime/internal"
import type { JourneyNode, StateMatch } from "./journey-client.ts"
import type { DurationInput } from "./duration.ts"
import type { RawTestApp } from "./test-app.ts"

export interface JourneyApp {
  readonly name: string
  readonly nodes: unknown
  readonly screens?: unknown
  readonly services?: unknown
  readonly scenarios: unknown
  readonly scenarioNames: readonly string[]
  readonly defaultScenario: string
}
export type AppJourneyNode<D, M = unknown> = Omit<
  JourneyNode<D, M>,
  "expectFailure" | "expectRefusal" | "allowCancellation"
>
type Definitions<D> = D extends { readonly name: string }
  ? D
  : D extends readonly unknown[]
    ? D[number]
    : D[keyof D]
type Table<D> = { [Item in Extract<D, { name: string }> as Item["name"]]: Item }
type Selected<D, C extends { name: string }> = Table<D>[C["name"] & keyof Table<D>]
type Meta<D> = D[keyof D & symbol]
type Contract<D> = D extends unknown
  ? Extract<Meta<D>, { contract: unknown }> extends infer M
    ? [M] extends [never]
      ? D
      : M extends { contract: infer C }
        ? C
        : D
    : never
  : never
type Identity<C> = C extends abstract new (
  ...args: never[]
) => object
  ? C
  : C extends { readonly [DEFINITION_IDENTITY]: infer I }
    ? { readonly name: C extends { name: infer N } ? N : never; readonly [DEFINITION_IDENTITY]: I }
    : C
type Member<C, Allowed> = [Identity<C>] extends [Identity<Allowed>]
  ? unknown
  : { readonly "Definition must belong to this app and scenario": never }
export type Screens<A> = A extends { screens: infer S } ? Definitions<S> : never
export type Services<A> = A extends { services: infer V }
  ? Definitions<V>
  : A extends { nodes: infer N }
    ? Exclude<Definitions<N>, Screens<A>>
    : never
export type Scenarios<A extends JourneyApp> = A["scenarioNames"][number]
export type DefaultScenario<A extends JourneyApp> = A["defaultScenario"] & Scenarios<A>
type Fixtures<A extends JourneyApp, K extends Scenarios<A>> = K extends keyof A["scenarios"]
  ? A["scenarios"][K] extends { fixtures: readonly (infer F)[] }
    ? F
    : never
  : never
type CommonFixtures<
  A extends JourneyApp,
  K extends Scenarios<A>,
  F = Fixtures<A, K>,
> = F extends unknown
  ? { [P in K]: F extends Fixtures<A, P> ? true : false }[K] extends true
    ? F
    : never
  : never
type Scenario<A extends JourneyApp, K extends Scenarios<A>> = K extends keyof A["scenarios"]
  ? A["scenarios"][K]
  : { readonly virtualTime: false }
type MatchVariant<S, M> = S extends unknown
  ? keyof M extends keyof S
    ? M extends { _tag: infer Tag }
      ? S extends { _tag: Tag }
        ? true
        : false
      : true
    : false
  : never
type MatchCheck<S, M> =
  true extends MatchVariant<S, M>
    ? unknown
    : { readonly "State match fields must belong to one variant": never }
export type Params<C> =
  Extract<Meta<C>, { paramsType: unknown } | { params: unknown }> extends infer M
    ? M extends { paramsType: infer P }
      ? P
      : M extends { encodedParams: infer P }
        ? P
        : never
    : never
export type Args<P> = keyof P extends never ? [] : [params: P]
export interface JourneyClientFor<A extends JourneyApp, K extends Scenarios<A> = DefaultScenario<A>>
  extends AsyncDisposable {
  readonly scenario: K
  readonly raw: RawTestApp
  focused<
    C extends { readonly name: string },
    const M extends StateMatch<InferState<Selected<Screens<A>, NoInfer<C>>>> = StateMatch<
      InferState<Selected<Screens<A>, C>>
    >,
  >(
    contract: C & NoInfer<Member<C, Contract<Selected<Screens<A>, C>> | Selected<Screens<A>, C>>>,
    match?: M & NoInfer<MatchCheck<InferState<Selected<Screens<A>, C>>, M>>,
  ): Promise<AppJourneyNode<Selected<Screens<A>, C>, M>>
  node<D extends ConsumerDefinition>(
    definition: D & NoInfer<Member<D, Services<A> | CommonFixtures<A, K>>>,
  ): Promise<AppJourneyNode<D, unknown>>
  service<D extends ConsumerDefinition>(
    definition: D & NoInfer<Member<D, Services<A>>>,
  ): Promise<AppJourneyNode<D, unknown>>
  fixture<D extends ConsumerDefinition>(
    definition: D & NoInfer<Member<D, CommonFixtures<A, K>>>,
  ): Promise<AppJourneyNode<D, unknown>>
  open<C extends { readonly name: string }>(
    contract: C & NoInfer<Member<C, Contract<Selected<Screens<A>, C>> | Selected<Screens<A>, C>>>,
    ...params: Args<Params<NoInfer<C>>>
  ): Promise<AppJourneyNode<Selected<Screens<A>, C>, unknown>>
  back(): Promise<void>
  advanceTime(
    this: [Scenario<A, K>] extends [{ readonly virtualTime: true }]
      ? JourneyClientFor<A, K>
      : { readonly "advanceTime requires a virtualTime scenario": never },
    duration: DurationInput,
  ): Promise<void>
  reset<S extends Scenarios<A>>(scenario: S): Promise<JourneyClientFor<A, S>>
  dispose(): Promise<void>
}
export type { InferState, InferActions }

export type JourneyClient<
  A extends JourneyApp,
  K extends Scenarios<A> = DefaultScenario<A>,
> = JourneyClientFor<A, K>
