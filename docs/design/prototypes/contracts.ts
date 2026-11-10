import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

// Declaration prototype: no package code is imported or changed.
export interface Contract<N extends string = string, S = unknown, P = unknown> {
  new (): object
  readonly name: N
  readonly state: { readonly Type: S }
  readonly paramsType: P
}
export interface Implementation<C, A> {
  readonly contract: C
  readonly actions: A
  // Runtime implementation identity is the implementation object itself.
}
export declare function Screen<Self>(): <
  const N extends string,
  S,
  const P extends Schema.Struct.Fields = Record<never, never>,
>(
  name: N,
  spec: {
    state: { readonly Type: S }
    params?: P
    initial: (params: Schema.Struct<P>["Type"]) => NoInfer<S>
  },
) => {
  new (): { readonly self: (_: Self) => Self }
  readonly name: N
  readonly state: { readonly Type: S }
  readonly paramsType: Schema.Struct<P>["Type"]
  implement<C extends Contract, const A>(
    this: C,
    spec: {
      actions: A
      onFocus?: (ctx: {
        state: { get: Effect.Effect<S>; set(value: S): Effect.Effect<void> }
      }) => Effect.Effect<void>
    },
  ): Implementation<C, A>
  handler<A, E, R>(f: (ctx: { state: S }) => Effect.Effect<A, E, R>): typeof f
}

export class Detail extends Screen<Detail>()("Detail", {
  state: Schema.Struct({ id: Schema.String }),
  params: { id: Schema.String },
  initial: ({ id }) => ({ id }),
}) {
  declare private readonly nominal: undefined
}
export class ForeignDetail extends Screen<ForeignDetail>()("Detail", {
  state: Schema.Struct({ id: Schema.String }),
  params: { id: Schema.String },
  initial: ({ id }) => ({ id }),
}) {
  declare private readonly nominal: undefined
}
export const A = Detail.implement({ actions: { One: () => 1 } })
export const B = Detail.implement({ actions: { Two: () => 2 } })
export const Foreign = ForeignDetail.implement({ actions: { One: () => 1 } })
const sameContract: typeof Detail = B.contract
void sameContract
// @ts-expect-error Separate private declarations make same-name/same-shape contracts nominal.
const wrongContract: typeof Detail = ForeignDetail
void wrongContract
// @ts-expect-error Implementations retain their own action maps; no shared resolve method.
B.actions.One()
// @ts-expect-error Contract identity and implementation identity are distinct types.
const wrongImplementation: typeof A = B
void wrongImplementation

export type Message<S extends string> = { readonly [K in S]: never }
export type Member<C, Allowed, App extends string, Kind extends string> = [C] extends [Allowed]
  ? unknown
  : Message<`${C extends { name: infer N extends string } ? N : "Value"} is not a ${Kind} of app '${App}'`>

export declare function bind<const N extends string, C extends Contract, A>(
  name: N,
  selected: Implementation<C, A>,
): {
  useScreen<const T extends { readonly name: string }>(
    contract: T & Member<NoInfer<T>, C, N, "screen">,
  ): A
}
const bound = bind("inventory", B)
bound.useScreen(Detail).Two()
// @ts-expect-error Diagnostic contains: Detail is not a screen of app 'inventory'.
bound.useScreen(ForeignDetail)
// @ts-expect-error Selected implementation B exposes Two, never A's One.
bound.useScreen(Detail).One()

// Counterexample: Self alone does NOT create nominal subclasses in TypeScript.
class EmptyA extends Screen<EmptyA>()("Same", {
  state: Schema.String,
  initial: () => "",
}) {}
class EmptyB extends Screen<EmptyB>()("Same", {
  state: Schema.String,
  initial: () => "",
}) {}
const structural: typeof EmptyA = EmptyB
void structural

Detail.implement({
  actions: { Read: () => 1 },
  onFocus: ({ state }) => state.set({ id: "ok" }),
})
Detail.implement({
  actions: {},
  // @ts-expect-error Self's decoded state cannot be replaced with another shape.
  onFocus: ({ state }) => state.set({ other: 1 }),
})
// @ts-expect-error Implementations are not contracts even if they retain a contract reference.
bound.useScreen(B)

const InventoryFixture = { name: "InventoryFixture" } as const
// @ts-expect-error Diagnostic names the fixture, rather than dumping constructor members.
bound.useScreen(InventoryFixture)
