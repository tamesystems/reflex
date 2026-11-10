import type { AppSession, NodeHandle, ActionOutcome, Runtime } from "@reflex/runtime/internal"
import { findRouteNode } from "@reflex/react/advanced"
import { stackReader } from "@reflex/navigation"
import { liveNodeOf } from "@reflex/effect/internal"
import type { Capability } from "@reflex/effect/advanced"
import { ROUTER_RETAINED_ENTRIES_MAX } from "@reflex/protocol"

type Node = NodeHandle<
  unknown,
  Record<string, (...args: never[]) => Promise<ActionOutcome<unknown>>>
>
const pending = new WeakMap<Runtime, Map<string, Promise<Node>>>()

/** Reuse one Suspense resource until the exact route query resolves, ignoring unrelated events. */
export const screenReady = (
  session: AppSession,
  contract: { readonly name: string },
  params: Record<string, unknown> | undefined,
  token: string | null,
): Promise<Node> => {
  const { runtime } = session
  let resources = pending.get(runtime)
  if (resources === undefined) {
    resources = new Map()
    pending.set(runtime, resources)
  }
  const key = JSON.stringify([contract.name, params, token])
  const existing = resources.get(key)
  if (existing !== undefined) {
    return existing
  }
  if (resources.size >= ROUTER_RETAINED_ENTRIES_MAX) {
    throw new Error("Too many screens are waiting for Suspense; check route bindings")
  }
  let complete!: (node: Node) => void
  let fail!: (error: unknown) => void
  const promise = new Promise<Node>((resolve, reject) => {
    complete = resolve
    fail = reject
  })
  resources.set(key, promise)
  const readStack = stackReader(session)
  let stop = () => {}
  const check = () => {
    try {
      const node = findRouteNode({
        stack: readStack(),
        token,
        params,
        resolve: (id) => liveNodeOf(runtime, id, contract as Capability<unknown, never, never>),
      })
      if (node === null) {
        return
      }
      stop()
      resources.delete(key)
      complete(node as Node)
    } catch (error) {
      stop()
      resources.delete(key)
      fail(error)
    }
  }
  stop = runtime.subscribe(check)
  check()
  return promise
}
