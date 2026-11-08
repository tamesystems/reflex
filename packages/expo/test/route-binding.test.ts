import { expect, test } from "bun:test"
import { toNodeId } from "@reflex/protocol"
import type { StackEntry } from "../src/projection.ts"
import { findRouteNode } from "../src/route-binding.ts"

const entry = (id: string, productId: string): StackEntry => ({
  route: "Detail",
  params: { productId },
  nodeId: toNodeId(id),
})

const stack = [entry("a", "1"), entry("b", "1"), entry("c", "2")]
const resolve = (nodeId: string) => `node ${nodeId}`

test("a token names its node exactly, even below the top", () => {
  const found = findRouteNode({ stack, token: "a", params: { productId: "1" }, resolve })
  expect(found).toBe("node a")
})

test("without a token, the topmost entry with those params is the one", () => {
  const found = findRouteNode({ stack, token: null, params: { productId: "1" }, resolve })
  expect(found).toBe("node b")
})

test("a token whose params no longer match does not win", () => {
  const found = findRouteNode({ stack, token: "a", params: { productId: "2" }, resolve })
  expect(found).toBe("node c")
})

test("a stale token falls back to the params", () => {
  const found = findRouteNode({ stack, token: "gone", params: { productId: "2" }, resolve })
  expect(found).toBe("node c")
})

test("nothing is bound until the core has the entry", () => {
  const found = findRouteNode({ stack, token: null, params: { productId: "9" }, resolve })
  expect(found).toBeNull()
})

test("an entry of another capability is not a match", () => {
  const onlyTop = (nodeId: string) => (nodeId === "a" ? undefined : `node ${nodeId}`)
  const found = findRouteNode({
    stack,
    token: "a",
    params: { productId: "1" },
    resolve: onlyTop,
  })
  expect(found).toBe("node b")
})
