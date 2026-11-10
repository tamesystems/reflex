import type { Capability } from "@reflex/effect"
import type { Destination } from "@reflex/navigation"
import { defined, isRecord, type Json } from "@reflex/protocol"
import * as Schema from "effect/Schema"

// Heterogeneous screens are checked individually where defined.
// biome-ignore lint/suspicious/noExplicitAny: each binding retains its concrete capability.
type AnyScreen = Capability<any, any, any, any>
type Params<C extends AnyScreen> = Schema.Schema.Type<C["params"]>
type Registration<C extends AnyScreen> =
  Record<string, never> extends Params<C>
    ? string
    : {
        readonly pathname: string
        readonly params: { readonly [K in keyof Params<C>]: string }
      }
export interface ScreenRoute<C extends AnyScreen> {
  readonly capability: C
  /** Validate file-route params and translate the application's chosen names. */
  params(raw: Record<string, string | readonly string[] | undefined>): Params<C> | null
  encodedParams(
    raw: Record<string, string | readonly string[] | undefined>,
  ): Record<string, unknown> | null
}

/** One registration derives both projection directions and each screen's params. */
export const expoRoutes = <const D extends Record<string, AnyScreen>>(
  navigation: { readonly screens: D },
  registration: { readonly [K in keyof D]: Registration<D[K]> },
) => {
  const entries = Object.entries(navigation.screens).map(([name, capability]) => {
    const registered = defined(registration[name], "every route has a registration")
    const pathname = typeof registered === "string" ? registered : registered.pathname
    const mapping: Record<string, string> = typeof registered === "string" ? {} : registered.params
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(capability.params))
    const encode = Schema.encodeSync(Schema.toCodecJson(capability.params))
    const params = (raw: Record<string, string | readonly string[] | undefined>) => {
      const value = Object.fromEntries(
        Object.entries(mapping).map(([core, file]) => {
          const part = raw[file]
          return [core, typeof part === "string" ? part : part?.[0]]
        }),
      )
      try {
        return decode(value, { onExcessProperty: "error" })
      } catch {
        return null
      }
    }
    return { name, capability, pathname, mapping, decode, encode, params }
  })
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
    toHref({ route, params }: Destination) {
      const entry = entries.find((entry) => entry.name === route)
      if (entry === undefined) {
        throw new Error(`Route "${route}" has no Expo registration`)
      }
      const decoded = entry.decode(params, { onExcessProperty: "error" })
      return {
        pathname: entry.pathname,
        params: Object.fromEntries(
          Object.entries(entry.mapping).map(([core, file]) => [file, String(decoded[core])]),
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
  }
}
