import {
  type BridgeConnector,
  ReflexProvider,
  useNode,
  useNodeState,
  useSession,
} from "@reflex/react"
import { useRouteFocus } from "@reflex/react-router"
import { isRecord } from "@reflex/protocol"
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Link, Route, Routes, useLocation } from "react-router"
import { type Entry, entryFor, existingEntry, host } from "./host.ts"

/**
 * The history entry's node: looked up during render, mounted only once committed, so a
 * render React throws away never leaves a node behind. Retained until reset, so that
 * browser forward finds the same node and state.
 */
const useEntry = (key: string, name: string): Entry | null => {
  const { runtime } = useSession()
  const [mounted, setMounted] = useState<{ readonly key: string; readonly entry: Entry } | null>(
    null,
  )
  useEffect(() => {
    setMounted({ key, entry: entryFor(runtime, key, name) })
  }, [runtime, key, name])
  return mounted?.key === key ? mounted.entry : existingEntry(runtime, key)
}

const Screen = ({
  name,
  pattern,
  entryKey,
}: {
  readonly name: string
  readonly pattern: string
  readonly entryKey?: string
}) => {
  const location = useLocation()
  const key = entryKey ?? location.key
  const entry = useEntry(key, name)
  const node = useNode(entry?.id ?? null)
  const state = useNodeState(node)
  useRouteFocus(entry?.id ?? null, pattern, key)
  if (key !== location.key || entry === null) {
    return null
  }
  return (
    <main>
      <h1>{name}</h1>
      <p>Count: {isRecord(state) ? String(state.count) : "loading"}</p>
      <button type="button" onClick={entry.add}>
        Add one
      </button>
      <Link to="/detail/one" replace={false}>
        Open detail
      </Link>
      <Link to="/">List</Link>
    </main>
  )
}
// Retain detail elements across same-URL pushes, as an app with a route cache might.
// Their owning entry keys must keep hidden elements from reporting current focus.
const DetailEntries = () => {
  const { key } = useLocation()
  const [keys, setKeys] = useState<readonly string[]>([key])
  useEffect(() => {
    setKeys((previous) => (previous.includes(key) ? previous : [...previous, key]))
  }, [key])
  return (
    <>
      {keys.map((entryKey) => (
        <Screen key={entryKey} name="Detail" pattern="/detail/:id" entryKey={entryKey} />
      ))}
    </>
  )
}

let bridge: BridgeConnector | undefined
if (import.meta.env.DEV) {
  const setting = import.meta.env.VITE_REFLEX_BRIDGE
  if (setting) {
    const { connectBridge } = await import("@reflex/live")
    bridge = connectBridge(setting)
  }
}
const root = document.getElementById("root")
if (root === null) {
  throw new Error("Missing root")
}
createRoot(root).render(
  <ReflexProvider host={host} bridge={bridge}>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Screen name="List" pattern="/" />} />
        <Route path="/detail/:id" element={<DetailEntries />} />
      </Routes>
    </BrowserRouter>
  </ReflexProvider>,
)
