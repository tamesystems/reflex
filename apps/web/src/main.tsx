import { developmentBridge } from "@reflex/live/vite"
import { ReflexProvider, useNodeState } from "@reflex/react"
import { useRouteFocus, useRouteNode } from "@reflex/react-router"
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Link, Route, Routes, useLocation } from "react-router"
import { List, Detail, host } from "./host.ts"

const Screen = ({ name, entryKey }: { readonly name: string; readonly entryKey?: string }) => {
  const location = useLocation()
  const key = entryKey ?? location.key
  const node = useRouteNode(name === "List" ? List : Detail, {
    lifetime: "history-entry",
    entryKey: key,
  })
  const state = useNodeState(node)
  useRouteFocus(node, key)
  if (key !== location.key || node === null) {
    return null
  }
  return (
    <main>
      <h1>{name}</h1>
      <p>Count: {state?.count ?? "loading"}</p>
      <button type="button" onClick={() => node.actions.Increment()}>
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
        <Screen key={entryKey} name="Detail" entryKey={entryKey} />
      ))}
    </>
  )
}

const bridge = await developmentBridge()
const root = document.getElementById("root")
if (root === null) {
  throw new Error("Missing root")
}
createRoot(root).render(
  <ReflexProvider host={host} bridge={bridge}>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Screen name="List" />} />
        <Route path="/detail/:id" element={<DetailEntries />} />
      </Routes>
    </BrowserRouter>
  </ReflexProvider>,
)
