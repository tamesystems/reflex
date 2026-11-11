import type { Msg, URLParams, Table, Screens, App } from "./binding-types.ts"
type Empty = Record<never, never>
type Required<P> = { [K in keyof P]-?: Empty extends Pick<P, K> ? never : K }[keyof P] & string
type Names<P> = keyof P & string
type Target<K, M> = K extends keyof M ? M[K] : K
type Targets<P, M> = Target<Names<P>, M> & string
type RequiredTargets<P, M> = Target<Required<P>, M> & string
type OptionalTargets<P, M> = Target<Exclude<Names<P>, Required<P>>, M> & string
type Duplicates<P, M> = {
  [K in Names<P>]: {
    [J in Exclude<Names<P>, K>]: Target<J, M> extends Target<K, M> ? J : never
  }[Exclude<Names<P>, K>]
}[Names<P>]
type Segment<S extends string> = S extends `:${infer K}` ? K : S extends `[${infer K}]` ? K : never
type Excluded<S extends string> = S extends
  | `${string}(${string}`
  | `${string})${string}`
  | `${string}*${string}`
  | `${string}...${string}`
  | `${string}?${string}`
  ? true
  : false
// Tail recursion retains duplicate information rather than collapsing it into a union.
type Parse<
  P extends string,
  Seen extends string = never,
  Repeat extends string = never,
> = P extends `${infer H}/${infer T}`
  ? Parse<T, Seen | Segment<H>, Repeat | Extract<Segment<H>, Seen>>
  : { names: Seen | Segment<P>; repeat: Repeat | Extract<Segment<P>, Seen> }
type BadEncoding<P> = {
  [K in keyof P]-?: Exclude<P[K], undefined> extends string ? never : K
}[keyof P] &
  string
export type CheckPath<P, Path extends string, Map> = string extends Path
  ? Msg<"Route path must be a literal; use advanced routeCodec for dynamic paths">
  : Excluded<Path> extends true
    ? Msg<"Excluded route grammar; use routeCodec">
    : Parse<Path>["repeat"] extends never
      ? BadEncoding<P> extends never
        ? Exclude<keyof Map, keyof P> extends never
          ? Duplicates<P, Map> extends never
            ? Exclude<Parse<Path>["names"], Targets<P, Map>> extends never
              ? Extract<Parse<Path>["names"], OptionalTargets<P, Map>> extends never
                ? Exclude<RequiredTargets<P, Map>, Parse<Path>["names"]> extends never
                  ? unknown
                  : Msg<`Required route param ${Exclude<RequiredTargets<P, Map>, Parse<Path>["names"]>} must appear as a path placeholder`>
                : Msg<`Optional route param ${Extract<Parse<Path>["names"], OptionalTargets<P, Map>>} cannot be a path placeholder`>
              : Msg<`Path placeholder ${Exclude<Parse<Path>["names"], Targets<P, Map>>} has no matching param; add a params mapping`>
            : Msg<"URL param mapping targets must be unique">
          : Msg<"URL param mapping names must be schema fields">
        : Msg<`URL param ${BadEncoding<P>} must encode a string; use a string codec`>
      : Msg<`Repeated path placeholder ${Parse<Path>["repeat"]}`>

type ByName<D, N> = Table<D>[N & keyof Table<D>]
export type ValidateRoutes<A extends App, R> = {
  [N in keyof Table<Screens<A>>]: N extends keyof R
    ? R[N] extends RouteCodec<URLParams<ByName<Screens<A>, N>>>
      ? unknown
      : R[N] extends string
        ? CheckPath<URLParams<ByName<Screens<A>, N>>, R[N], Empty>
        : R[N] extends { path: infer P extends string; params: infer Map }
          ? CheckPath<URLParams<ByName<Screens<A>, N>>, P, Map>
          : R[N] extends { pathname: infer P extends string; params?: infer Map }
            ? CheckPath<URLParams<ByName<Screens<A>, N>>, P, Map>
            : Msg<"Use a literal route or routeCodec">
    : Msg<`${N & string} needs a route registration`>
}

export function route<P>() {
  return <const Path extends string, const Map extends object = Record<never, never>>(
    path: Path & CheckPath<P, NoInfer<Path>, NoInfer<Map>>,
    mapping?: Map,
  ) => ({ path, mapping: mapping ?? ({} as Map), params: mapping ?? ({} as Map) })
}
export interface RouteCodec<P> {
  readonly path: string
  decode(raw: Readonly<Record<string, string | string[] | undefined>>): P
  encode(params: P): string
}
export const routeCodec = <P>(spec: RouteCodec<P>): RouteCodec<P> => spec
