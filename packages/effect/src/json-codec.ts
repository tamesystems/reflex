import * as Representation from "effect/SchemaRepresentation"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Getter from "effect/SchemaGetter"
import { publishJson } from "@reflex/runtime/internal"
import type { Json } from "@reflex/protocol"
import type { Codec, JsonCheck } from "./author-model.ts"
import type { Erased } from "./erased.ts"

/** Explicit JSON representation for a decoded value with no natural wire codec. */
export const jsonCodec = <C extends Codec, W>(
  source: C,
  wire: {
    readonly encode: (value: C["Type"]) => W
    readonly decode: (value: unknown) => Effect.Effect<C["Type"], Schema.SchemaError>
    readonly jsonSchema: object
  } & JsonCheck<NoInfer<W>, "Wire codec must encode JSON">,
): Schema.Codec<C["Type"], W> & { readonly source: C } => {
  const from = Representation.fromJsonSchemaDocument({
    dialect: "draft-2020-12",
    schema: wire.jsonSchema as Erased,
    definitions: {},
  }) as Schema.Codec<unknown, unknown>
  const codec = from.pipe(
    Schema.decodeTo(Schema.toType(source), {
      decode: Getter.transformEffect((value) =>
        wire.decode(value).pipe(Effect.mapError((error) => error.issue)),
      ),
      encode: Getter.transform((value) => publishJson(wire.encode(value) as Json)),
    }),
  )
  return Object.assign(codec, { source }) as Erased
}
