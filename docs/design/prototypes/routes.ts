import type { Message } from "./contracts.ts"

type Segment<S extends string> = S extends `:${infer K}` ? K : S extends `[${infer K}]` ? K : never
export type Placeholders<P extends string> = P extends `${infer H}/${infer T}`
  ? Segment<H> | Placeholders<T>
  : Segment<P>
type RequiredKeys<P> = {
  [K in keyof P]-?: Record<never, never> extends Pick<P, K> ? never : K
}[keyof P] &
  string
type Names<P> = keyof P & string
type Targets<P, M> = { [K in Names<P>]: K extends keyof M ? M[K] : K }[Names<P>] & string
type RequiredTargets<P, M> = {
  [K in RequiredKeys<P>]: K extends keyof M ? M[K] : K
}[RequiredKeys<P>] &
  string
type Duplicates<P, M> = {
  [K in Names<P>]: {
    [J in Exclude<Names<P>, K>]: (J extends keyof M ? M[J] : J) extends (
      K extends keyof M
        ? M[K]
        : K
    )
      ? J
      : never
  }[Exclude<Names<P>, K>]
}[Names<P>]
export type CheckPath<P, Path extends string, M> = string extends Path
  ? Message<"Route path must be a literal; use advanced routeCodec for dynamic paths">
  : Exclude<keyof M, keyof P> extends never
    ? Exclude<Placeholders<Path>, Targets<P, M>> extends never
      ? Exclude<RequiredTargets<P, M>, Placeholders<Path>> extends never
        ? Duplicates<P, M> extends never
          ? unknown
          : Message<"URL param mapping targets must be unique">
        : Message<"Required route params must appear as path placeholders">
      : Message<"Path placeholder has no matching param; add a params mapping">
    : Message<"URL param mapping names must be schema fields">

export declare function route<P>(): <
  const Path extends string,
  const M extends Partial<Record<Names<P>, string>> = Record<never, never>,
>(
  path: Path & CheckPath<P, NoInfer<Path>, NoInfer<M>>,
  mapping?: M,
) => { path: Path; mapping: M }
const detail = route<{ productId: string; tab?: string }>()
detail("/inventory/[productId]")
detail("/inventory/[id]", { productId: "id" })
detail("/inventory/:productId")
// @ts-expect-error Path placeholder has no matching param; add a params mapping.
detail("/inventory/[id]")
// @ts-expect-error Required route params must appear as path placeholders.
detail("/inventory")
// @ts-expect-error URL param mapping targets must be unique.
detail("/inventory/[id]", { productId: "id", tab: "id" })
// @ts-expect-error Mapping key must be a schema field.
detail("/inventory/[productId]", { typo: "id" })
// @ts-expect-error Dynamic paths use the advanced codec.
detail("/inventory/:productId" as string)
