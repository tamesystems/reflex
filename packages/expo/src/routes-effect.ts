import { ROUTE_MAPPING } from "./route-token.ts"
import type { Capability } from "@reflex/effect"
import type { Destination } from "@reflex/navigation"
import { defined, isRecord, type Json } from "@reflex/protocol"
import * as Schema from "effect/Schema"

// Heterogeneous screens are checked individually where defined.
// biome-ignore lint/suspicious/noExplicitAny: each binding retains its concrete capability.
type AnyScreen = Capability<any, any, any, any>
type Params<C extends AnyScreen> = Schema.Schema.Type<C["params"]>
type WireParams<C extends AnyScreen> = Schema.Codec.Encoded<C["params"]>
type UrlFields<C extends AnyScreen> = {
  readonly [K in keyof Params<C>]: K extends keyof WireParams<C>
    ? WireParams<C>[K] extends string | undefined
      ? string
      : { readonly error: "URL params must encode strings"; readonly field: K }
    : { readonly error: "URL param keys must match encoded keys"; readonly field: K }
}
type Registration<C extends AnyScreen> = keyof Params<C> extends never
  ? string
  : string extends keyof Params<C>
    ? string
    : {
        readonly pathname: string
        readonly params: UrlFields<C>
      }
export interface ScreenRoute<C extends AnyScreen> {
  readonly capability: C
  /** Validate file-route params and translate the application's chosen names. */
  params(raw: Record<string, string | readonly string[] | undefined>): Params<C> | null
  encodedParams(
    raw: Record<string, string | readonly string[] | undefined>,
  ): Record<string, unknown> | null
}

export class InvalidRouteParams extends Error {
  override readonly name = "InvalidRouteParams"
  constructor(
    readonly route: string,
    readonly params: Record<string, string | readonly string[] | undefined>,
    override readonly cause: unknown,
  ) {
    super(
      `Route "${route}" has invalid URL params: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

const validateUrlParams = (
  name: string,
  capability: AnyScreen,
  pathname: string,
  mapping: Record<string, string>,
): void => {
  const document = Schema.toJsonSchemaDocument(Schema.toCodecJson(capability.params))
  const schema = document.schema
  if ("properties" in schema && schema.properties) {
    for (const [field, spec] of Object.entries(schema.properties)) {
      if (
        typeof spec !== "object" ||
        spec === null ||
        !("type" in spec) ||
        spec.type !== "string"
      ) {
        throw new Error(
          `Route "${name}" field "${field}" must use a URL string codec (for numbers use Schema.NumberFromString)`,
        )
      }
      if (!(field in mapping)) {
        throw new Error(`Route "${name}" field "${field}" is missing its URL mapping`)
      }
    }
    for (const field of Object.keys(mapping)) {
      if (!(field in (schema.properties as object))) {
        throw new Error(
          `Route "${name}" field "${field}" differs from its encoded key; use an explicit URL codec`,
        )
      }
    }
  }
  const placeholders = [...pathname.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1])
  for (const placeholder of placeholders) {
    if (!Object.values(mapping).includes(placeholder ?? "")) {
      throw new Error(`Route "${name}" placeholder "${placeholder}" has no param mapping`)
    }
  }
}

/** One registration derives both projection directions and each screen's params. */
type Placeholders<P extends string> = P extends `${string}[${infer Segment}]${infer Rest}`
  ? Segment | Placeholders<Rest>
  : never
type CheckPath<R> = R extends {
  readonly pathname: infer P extends string
  readonly params: infer M extends Record<string, unknown>
}
  ? Exclude<Placeholders<P>, M[keyof M]> extends never
    ? unknown
    : {
        readonly "Pathname placeholders need matching param names": Exclude<
          Placeholders<P>,
          M[keyof M]
        >
      }
  : R extends string
    ? Placeholders<R> extends never
      ? unknown
      : { readonly "Pathname placeholders need params": Placeholders<R> }
    : unknown
export const expoRoutes = <
  const D extends Record<string, AnyScreen>,
  const R extends { readonly [K in keyof D]: Registration<D[K]> },
>(
  navigation: { readonly screens: D },
  registration: R & { readonly [K in keyof R]: CheckPath<R[K]> },
) => {
  const entries = Object.entries(navigation.screens).map(([name, capability]) => {
    const registered = defined(registration[name], "every route has a registration")
    const pathname = typeof registered === "string" ? registered : registered.pathname
    const mapping: Record<string, string> =
      typeof registered === "string" ? {} : (registered.params as Record<string, string>)
    validateUrlParams(name, capability, pathname, mapping)
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(capability.params))
    const encode = Schema.encodeSync(Schema.toCodecJson(capability.params))
    const params = (raw: Record<string, string | readonly string[] | undefined>) => {
      const value = Object.fromEntries(
        Object.entries(mapping).map(([core, file]) => {
          const part = raw[file]
          return [core, typeof part === "string" ? part : part?.[0]]
        }),
      )
      for (const key of Object.keys(value)) {
        if (value[key] === undefined) {
          delete value[key]
        }
      }
      try {
        return decode(value, { onExcessProperty: "error" })
      } catch (cause) {
        throw new InvalidRouteParams(name, raw, cause)
      }
    }
    return { name, capability, pathname, mapping, decode, encode, params }
  })
  const encodeDecoded = (
    entry: (typeof entries)[number],
    decoded: unknown,
  ): Record<string, unknown> => {
    const encoded = entry.encode(decoded)
    if (!isRecord(encoded)) {
      throw new Error(`Route "${entry.name}" params must encode an object`)
    }
    return encoded
  }
  const bindings = Object.fromEntries(
    entries.map((entry) => [
      entry.name,
      {
        capability: entry.capability,
        params: entry.params,
        encodedParams: (raw: Record<string, string | readonly string[] | undefined>) => {
          const params = entry.params(raw)
          if (params === null) {
            return null
          }
          const encoded = entry.encode(params)
          if (!isRecord(encoded)) {
            throw new Error(`Route "${entry.name}" params must encode an object`)
          }
          return encoded
        },
      },
    ]),
  ) as { readonly [K in keyof D]: ScreenRoute<D[K]> }
  return {
    ...bindings,
    [ROUTE_MAPPING]: {
      toHref({ route, params }: Destination) {
        const entry = entries.find((entry) => entry.name === route)
        if (entry === undefined) {
          throw new Error(`Route "${route}" has no Expo registration`)
        }
        const decoded = entry.decode(params, { onExcessProperty: "error" })
        return {
          pathname: entry.pathname,
          params: Object.fromEntries(
            Object.entries(entry.mapping)
              .filter(([core]) => encodeDecoded(entry, decoded)[core] !== undefined)
              .map(([core, file]) => [file, String(encodeDecoded(entry, decoded)[core])]),
          ),
        }
      },
      fromLocation(
        segments: readonly string[],
        raw: Record<string, string | readonly string[] | undefined>,
      ): Destination | null {
        const entry = entries.find((entry) => entry.pathname === `/${segments.join("/")}`)
        if (entry === undefined) {
          return null
        }
        const params = entry.params(raw)
        return params === null ? null : { route: entry.name, params: entry.encode(params) as Json }
      },
    },
  }
}
