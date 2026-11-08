import { type Destination, type RouteParams, type RouterHref, routeParam } from "@reflex/expo"
import type { Json } from "@reflex/protocol"

/** The only place that knows how core routes and file routes correspond. */
export const toHref = ({ route, params }: Destination): RouterHref => {
  switch (route) {
    case "InventoryList":
      return { pathname: "/" }
    case "InventoryDetail":
      return { pathname: "/inventory/[id]", params: { id: productIdOf(params) } }
    case "Settings":
      return { pathname: "/settings" }
    default:
      throw new Error(`Route "${route}" has no screen`)
  }
}

const productIdOf = (params: Json): string => {
  if (typeof params === "object" && params !== null && "productId" in params) {
    const { productId } = params
    if (typeof productId === "string") {
      return productId
    }
  }
  throw new Error("InventoryDetail needs a productId")
}

export const fromLocation = (
  segments: ReadonlyArray<string>,
  params: RouteParams,
): Destination | null => {
  const [first, second] = segments
  if (first === undefined) {
    return { route: "InventoryList", params: {} }
  }
  if (first === "settings") {
    return { route: "Settings", params: {} }
  }
  if (first === "inventory" && second === "[id]") {
    const productId = routeParam(params.id)
    return productId === null ? null : { route: "InventoryDetail", params: { productId } }
  }
  return null
}
