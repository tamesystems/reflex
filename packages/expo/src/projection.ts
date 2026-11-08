/**
 * The core navigator is authoritative; the router is a projection of it. These
 * pure functions decide every synchronization step, so the rules can be tested
 * without a renderer. The router is told what to do, and what it does on its
 * own arrives as a core event.
 *
 * Router entries are identified by the core node they were pushed for, carried
 * as a route param. A URL cannot do this: two entries can share one.
 */
import {
  array,
  defined,
  type Json,
  json,
  nodeId,
  type NodeId,
  object,
  type Parser,
  string,
} from "@reflex/protocol"

/** Route param holding the core node an entry was pushed for. */
export const NODE_PARAM = "reflexNode"

export interface Destination {
  readonly route: string
  readonly params: Json
}

export interface StackEntry extends Destination {
  readonly nodeId: NodeId
}

/** The `Navigation` node's state, as it arrives through the protocol. */
export const navigationState: Parser<{ readonly stack: ReadonlyArray<StackEntry> }> = object({
  stack: array(object({ route: string, params: json, nodeId })),
})

/** Where the router is. Null destination: a path with no core route. */
export interface RouterLocation {
  readonly token: string | null
  readonly destination: Destination | null
}

/** One core entry, and what the router has for it. */
export type Applied =
  | {
      readonly entry: StackEntry
      /** Null for an entry that did not come from a core push, and was not tagged. */
      readonly token: string | null
      readonly inRouter: true
    }
  /** A screen the core holds beneath a cold deep link. */
  | { readonly entry: StackEntry; readonly token: null; readonly inRouter: false }

export type RouterCommand =
  | { readonly type: "back"; readonly count: number }
  | { readonly type: "push"; readonly entry: StackEntry }
  | { readonly type: "replace"; readonly entry: StackEntry }
  /** Name the node on the entry already on screen. */
  | { readonly type: "tag"; readonly entry: StackEntry }

/** Not `localeCompare`: collation can call distinct keys equal, leaving their order. */
const byExactKey = ([left]: readonly [string, unknown], [right]: readonly [string, unknown]) =>
  left < right ? -1 : 1

/** Key order is not significant in params, so it must not decide equality. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_, item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return item
    }
    return Object.fromEntries(Object.entries(item).sort(byExactKey))
  })

export const sameDestination = (a: Destination, b: Destination): boolean => {
  if (a.route !== b.route) {
    return false
  }
  return canonicalJson(a.params) === canonicalJson(b.params)
}

export const sameLocation = (a: RouterLocation, b: RouterLocation): boolean => {
  if (a.token !== b.token) {
    return false
  }
  if (a.destination === null || b.destination === null) {
    return a.destination === b.destination
  }
  return sameDestination(a.destination, b.destination)
}

const pushed = (entry: StackEntry): Applied => ({ entry, token: entry.nodeId, inRouter: true })

/** The router's first state, before anything has been reconciled. */
export const initialApplied = (
  root: StackEntry,
  location: RouterLocation,
): ReadonlyArray<Applied> => {
  const onScreen = location.destination !== null && sameDestination(root, location.destination)
  // A leftover token from a bookmark still means this root, not a new screen.
  return [
    onScreen
      ? { entry: root, token: location.token, inRouter: true }
      : { entry: root, token: null, inRouter: false },
  ]
}

/** A destination already on screen, or one the user has since moved on from. */
export interface Adopting {
  readonly destination: Destination
  readonly onScreen: boolean
}

export interface SyncResult {
  readonly applied: ReadonlyArray<Applied>
  readonly commands: ReadonlyArray<RouterCommand>
}

/**
 * What must happen to the router so that it shows `stack`. An adopted destination
 * is already in the router, so its core push is not repeated. It is tagged, to
 * have the same exact identity as any other entry, unless the user has moved on:
 * tagging acts on whatever is visible, which would no longer be that entry.
 */
export const syncRouter = (
  applied: ReadonlyArray<Applied>,
  stack: ReadonlyArray<StackEntry>,
  adopting: Adopting | null,
): SyncResult => {
  const sharedCount = countShared(applied, stack)
  const kept = applied.slice(0, sharedCount)
  const poppedCount = applied.length - sharedCount
  const added = stack.slice(sharedCount)
  const [first, ...rest] = added

  if (poppedCount === 0 && first === undefined) {
    return { applied, commands: [] }
  }
  if (poppedCount === 0 && first !== undefined && adopting !== null) {
    if (sameDestination(first, adopting.destination)) {
      return adopt({ kept, first, rest, onScreen: adopting.onScreen })
    }
  }
  const poppedRouterCount = applied.slice(sharedCount).filter(({ inRouter }) => inRouter).length
  if (poppedCount > 0 && !kept.some(({ inRouter }) => inRouter)) {
    return rebuildHistory(kept, added, poppedRouterCount)
  }
  const back: ReadonlyArray<RouterCommand> =
    poppedRouterCount > 0 ? [{ type: "back", count: poppedRouterCount }] : []
  return {
    applied: [...kept, ...added.map(pushed)],
    commands: [...back, ...added.map(pushCommand)],
  }
}

const adopt = ({
  kept,
  first,
  rest,
  onScreen,
}: {
  readonly kept: ReadonlyArray<Applied>
  readonly first: StackEntry
  readonly rest: ReadonlyArray<StackEntry>
  readonly onScreen: boolean
}): SyncResult => {
  const adopted: Applied = onScreen ? pushed(first) : { entry: first, token: null, inRouter: true }
  const tag: ReadonlyArray<RouterCommand> = onScreen ? [{ type: "tag", entry: first }] : []
  return {
    applied: [...kept, adopted, ...rest.map(pushed)],
    commands: [...tag, ...rest.map(pushCommand)],
  }
}

const pushCommand = (entry: StackEntry): RouterCommand => ({ type: "push", entry })

const countShared = (applied: ReadonlyArray<Applied>, stack: ReadonlyArray<StackEntry>): number => {
  let sharedCount = 0
  while (
    sharedCount < applied.length &&
    applied[sharedCount]?.entry.nodeId === stack[sharedCount]?.nodeId
  ) {
    sharedCount++
  }
  return sharedCount
}

/**
 * Everything left is beneath the router's history, so it cannot go back there:
 * keep one entry and replace it with the destination.
 */
const rebuildHistory = (
  kept: ReadonlyArray<Applied>,
  added: ReadonlyArray<StackEntry>,
  poppedRouterCount: number,
): SyncResult => {
  const back: ReadonlyArray<RouterCommand> =
    poppedRouterCount > 1 ? [{ type: "back", count: poppedRouterCount - 1 }] : []
  const [first, ...rest] = added
  if (first !== undefined) {
    return {
      applied: [...kept, ...added.map(pushed)],
      commands: [...back, { type: "replace", entry: first }, ...rest.map(pushCommand)],
    }
  }
  const { entry } = defined(kept.at(-1), "the root is never popped")
  return {
    applied: [...kept.slice(0, -1), pushed(entry)],
    commands: [...back, { type: "replace", entry }],
  }
}

export type CoreCommand =
  | { readonly type: "none" }
  | { readonly type: "goBack"; readonly count: number }
  | { readonly type: "navigate"; readonly destination: Destination }

/**
 * The router moved. Nothing happened if this is the top entry. A lower entry
 * means a return (back gesture, hardware back). Anything else is a new
 * destination (deep link, or forward to an entry the core has since closed).
 */
export const interpret = (
  applied: ReadonlyArray<Applied>,
  location: RouterLocation,
): CoreCommand => {
  const { destination, token } = location
  if (destination === null) {
    return { type: "none" }
  }
  const topIndex = applied.length - 1
  for (let index = topIndex; index >= 0; index--) {
    const candidate = defined(applied[index], "index is within the stack")
    if (candidate.token === token && sameDestination(candidate.entry, destination)) {
      return index === topIndex ? { type: "none" } : { type: "goBack", count: topIndex - index }
    }
  }
  return { type: "navigate", destination }
}
