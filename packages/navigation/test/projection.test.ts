import { expect, test } from "bun:test"
import { type Json, toNodeId } from "@reflex/protocol"
import {
  type Applied,
  initialApplied,
  interpret,
  type RouterLocation,
  sameDestination,
  type StackEntry,
  syncRouter,
} from "../src/projection.ts"

const entry = (id: string, route = id, params: Json = {}): StackEntry => ({
  route,
  params,
  nodeId: toNodeId(id),
})
const [a, b, c, d] = [entry("a"), entry("b"), entry("c"), entry("d")] as [
  StackEntry,
  StackEntry,
  StackEntry,
  StackEntry,
]

const root = (e: StackEntry): Applied => ({ entry: e, token: null, inRouter: true })
const on = (e: StackEntry): Applied => ({ entry: e, token: e.nodeId, inRouter: true })
const beneath = (e: StackEntry): Applied => ({ entry: e, token: null, inRouter: false })
const at = (e: StackEntry, token: string | null = e.nodeId): RouterLocation => ({
  token,
  destination: e,
})

const commands = (applied: ReadonlyArray<Applied>, stack: ReadonlyArray<StackEntry>) =>
  syncRouter(applied, stack, null).commands

test("nothing to do when the router already matches", () => {
  expect(commands([root(a), on(b)], [a, b])).toEqual([])
})

test("pushes and pops are the difference between stacks", () => {
  expect(commands([root(a)], [a, b, c])).toEqual([
    { type: "push", entry: b },
    { type: "push", entry: c },
  ])
  expect(commands([root(a), on(b), on(c)], [a])).toEqual([{ type: "back", count: 2 }])
})

test("a replaced screen pops before pushing, compared by instance not route", () => {
  const again = entry("b2", "b")
  expect(commands([root(a), on(b)], [a, again])).toEqual([
    { type: "back", count: 1 },
    { type: "push", entry: again },
  ])
})

test("popping to a screen the router never had replaces instead of backing out of history", () => {
  // Cold deep link: the core holds `a` beneath `b`, the router only has `b`.
  const result = syncRouter([beneath(a), root(b)], [a], null)
  expect(result.commands).toEqual([{ type: "replace", entry: a }])
  expect(result.applied).toEqual([on(a)])
})

test("a batched pop past the start of history cannot resurrect a route", () => {
  // Router has [b, c]. Backing twice would stop on b and leave it on screen.
  expect(commands([beneath(a), root(b), on(c)], [a])).toEqual([
    { type: "back", count: 1 },
    { type: "replace", entry: a },
  ])
})

test("replacing everything in the router with a new screen keeps its history valid", () => {
  expect(commands([beneath(a), root(b)], [a, d])).toEqual([{ type: "replace", entry: d }])
})

test("an adopted destination is tagged rather than pushed again", () => {
  const result = syncRouter([beneath(a)], [a, b], { destination: b, onScreen: true })
  expect(result.commands).toEqual([{ type: "tag", entry: b }])
  expect(result.applied.at(-1)).toEqual(on(b))
})

test("pushes that land with an adoption follow its tag", () => {
  expect(syncRouter([root(a)], [a, b, c], { destination: b, onScreen: true }).commands).toEqual([
    { type: "tag", entry: b },
    { type: "push", entry: c },
  ])
})

test("an adoption no longer on screen stays untagged", () => {
  const result = syncRouter([root(a)], [a, b], { destination: b, onScreen: false })
  expect(result.commands).toEqual([])
  expect(result.applied.at(-1)).toEqual({ entry: b, token: null, inRouter: true })
})

test("an adoption only matches its own destination", () => {
  const result = syncRouter([root(a)], [a, c], { destination: b, onScreen: true })
  expect(result.commands).toEqual([{ type: "push", entry: c }])
})

test("the router's first state knows whether the root is on screen", () => {
  expect(initialApplied(a, at(a, null))).toEqual([root(a)])
  expect(initialApplied(a, at(b, null))).toEqual([beneath(a)])
})

test("a leftover token on the root is the root, not a new destination", () => {
  const stale = at(a, "gone")
  expect(interpret(initialApplied(a, stale), stale)).toEqual({ type: "none" })
})

test("arriving at the top is not an event, which is what prevents loops", () => {
  expect(interpret([root(a), on(b)], at(b))).toEqual({ type: "none" })
})

test("arriving lower in the stack is a return", () => {
  expect(interpret([root(a), on(b), on(c)], at(b))).toEqual({ type: "goBack", count: 1 })
  expect(interpret([root(a), on(b), on(c)], at(a, null))).toEqual({ type: "goBack", count: 2 })
})

test("identical URLs are told apart by the node they were pushed for", () => {
  const first = entry("x1", "x", { id: 1 })
  const second = entry("x2", "x", { id: 1 })
  const applied = [root(a), on(first), on(second)]
  expect(interpret(applied, at(first))).toEqual({ type: "goBack", count: 1 })
  expect(interpret(applied, at(second))).toEqual({ type: "none" })
})

test("params are compared by value, not by key order", () => {
  const destination = { route: "x", params: { a: 1, b: 2 } }
  const reordered = { route: "x", params: { b: 2, a: 1 } }
  expect(sameDestination(destination, reordered)).toBe(true)
  expect(sameDestination(destination, { route: "x", params: { a: 1, b: 3 } })).toBe(false)
  expect(sameDestination(destination, { route: "y", params: { a: 1, b: 2 } })).toBe(false)
})

test("keys that collate alike are still ordered exactly", () => {
  const composed = { route: "x", params: { é: 1, "e\u0301": 2 } }
  const decomposed = { route: "x", params: { "e\u0301": 2, é: 1 } }
  expect(sameDestination(composed, decomposed)).toBe(true)
})

test("repeated root entries are distinct too", () => {
  const again = entry("a2", "a")
  expect(interpret([root(a), on(again)], at(a, null))).toEqual({ type: "goBack", count: 1 })
})

test("forward to an entry the core has closed is a new destination", () => {
  expect(interpret([root(a)], at(b))).toEqual({ type: "navigate", destination: b })
})

test("a path with no core route is left alone", () => {
  expect(interpret([root(a)], { token: null, destination: null })).toEqual({ type: "none" })
})
