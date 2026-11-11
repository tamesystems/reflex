import type * as M from "./model"
type Required<P> = { [K in keyof P]-?: M.Empty extends Pick<P, K> ? never : K }[keyof P] & string
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
  ? M.Msg<"Route path must be a literal; use advanced routeCodec for dynamic paths">
  : Excluded<Path> extends true
    ? M.Msg<"Excluded route grammar; use routeCodec">
    : Parse<Path>["repeat"] extends never
      ? BadEncoding<P> extends never
        ? Exclude<keyof Map, keyof P> extends never
          ? Duplicates<P, Map> extends never
            ? Exclude<Parse<Path>["names"], Targets<P, Map>> extends never
              ? Extract<Parse<Path>["names"], OptionalTargets<P, Map>> extends never
                ? Exclude<RequiredTargets<P, Map>, Parse<Path>["names"]> extends never
                  ? unknown
                  : M.Msg<`Required route param ${Exclude<RequiredTargets<P, Map>, Parse<Path>["names"]>} must appear as a path placeholder`>
                : M.Msg<`Optional route param ${Extract<Parse<Path>["names"], OptionalTargets<P, Map>>} cannot be a path placeholder`>
              : M.Msg<`Path placeholder ${Exclude<Parse<Path>["names"], Targets<P, Map>>} has no matching param; add a params mapping`>
            : M.Msg<"URL param mapping targets must be unique">
          : M.Msg<"URL param mapping names must be schema fields">
        : M.Msg<`URL param ${BadEncoding<P>} must encode a string; use a string codec`>
      : M.Msg<`Repeated path placeholder ${Parse<Path>["repeat"]}`>
export declare function route<P>(): <const Path extends string, const Map extends object = M.Empty>(
  path: Path & CheckPath<P, NoInfer<Path>, NoInfer<Map>>,
  mapping?: Map,
) => { path: Path; mapping: Map }
export interface RouteCodec<P> {
  readonly path: string
  decode(raw: Readonly<Record<string, string | string[] | undefined>>): P
  encode(params: P): string
}
export declare function routeCodec<P>(spec: RouteCodec<P>): RouteCodec<P>
type ByName<D, N> = M.DefinitionMap<D>[N & keyof M.DefinitionMap<D>]
type Validate<D, R> = {
  [N in M.Names<D>]: N extends keyof R
    ? R[N] extends RouteCodec<M.URLParams<ByName<D, N>>>
      ? unknown
      : R[N] extends string
        ? CheckPath<M.URLParams<ByName<D, N>>, R[N], M.Empty>
        : R[N] extends { path: infer P extends string; params: infer Map }
          ? CheckPath<M.URLParams<ByName<D, N>>, P, Map>
          : R[N] extends { pathname: infer P extends string; params?: infer Map }
            ? CheckPath<M.URLParams<ByName<D, N>>, P, Map>
            : M.Msg<"Use a literal route or routeCodec">
    : M.Msg<`${N} needs a route registration`>
}
export type ValidateRoutes<A extends M.AnyApp, R> = Validate<A["screens"], R>
