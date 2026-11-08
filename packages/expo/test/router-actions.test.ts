/**
 * `router-actions.ts` leans on two private Expo Router modules. These pin what it
 * needs from them, so an upgrade that moves or changes them fails here first.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { internalNavigationEvents } from "expo-router/build/global-state/internalNavigationEvents"
import { onRouterAction, type RouteInfo } from "../src/router-actions.ts"

/** The version the private modules were read against. Changing it means reading again. */
const CHECKED_EXPO_ROUTER_VERSION = "58.0.30"

const stateShowing = (name: string, params: Record<string, string>) => ({
  key: "root",
  index: 0,
  routes: [
    {
      key: "root-0",
      name: "__root",
      state: {
        key: "stack",
        index: 1,
        routes: [
          { key: "a", name: "index" },
          { key: "b", name, params },
        ],
      },
    },
  ],
})

const emit = (state: unknown) =>
  internalNavigationEvents.emit("actionDispatched", {
    actionType: "PUSH",
    payload: undefined,
    state: state as never,
  })

test("the private modules are the version they were checked against", () => {
  const require = createRequire(import.meta.url)
  const manifest = JSON.parse(readFileSync(require.resolve("expo-router/package.json"), "utf8"))
  expect(manifest.version).toBe(CHECKED_EXPO_ROUTER_VERSION)
})

test("each action is read as the hooks would read the state it left, in order", () => {
  const seen: Array<RouteInfo> = []
  const stop = onRouterAction((info) => seen.push(info))
  emit(stateShowing("inventory/[id]", { id: "p 1", reflexNode: "screen/1" }))
  emit(stateShowing("settings", {}))
  stop()
  expect(seen).toEqual([
    { segments: ["inventory", "[id]"], params: { id: "p 1", reflexNode: "screen/1" } },
    { segments: ["settings"], params: {} },
  ])
})

test("a listener that has stopped hears nothing more", () => {
  let heardCount = 0
  const stop = onRouterAction(() => {
    heardCount++
  })
  stop()
  emit(stateShowing("settings", {}))
  expect(heardCount).toBe(0)
})
