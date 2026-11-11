import type * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type { OwnedNode } from "./runtime-advanced"
import type * as M from "./model"
export type {
  StateAccess,
  EffectContext,
  EffectActionBuilder,
  NavigationCommand,
  NavigationRefused,
  StateChanged,
} from "./model"
export declare function mountEffect<D extends M.AnyDef>(
  definition: D,
): Effect.Effect<OwnedNode<D>, never, D["requirements"] | Scope.Scope>
export declare function jsonCodec<C extends M.Codec, W>(
  codec: C,
  wire: {
    encode(value: C["Type"]): W
    decode(value: unknown): Effect.Effect<C["Type"], Schema.SchemaError>
    jsonSchema: object
  } & M.JsonCheck<NoInfer<W>, "Wire codec must encode JSON">,
): Schema.Codec<C["Type"], W> & { readonly source: C }
