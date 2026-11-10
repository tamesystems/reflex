import { developmentBridge } from "@reflex/live/vite"
import { ReflexProvider } from "@reflex/react"
import { useScreen } from "@reflex/react-router"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Link, Route, Routes } from "react-router"
import { List, Detail, host } from "./host.ts"

const useListScreen = () => useScreen(List)
const CounterScreen = ({
  title,
  view,
}: {
  readonly title: string
  readonly view: ReturnType<typeof useListScreen>
}) => {
  if (view.status === "pending") {
    return <p>Loading…</p>
  }
  return (
    <main>
      <h1>{title}</h1>
      <p>Count: {view.state.count}</p>
      <button
        type="button"
        disabled={!view.actions.Increment.available}
        onClick={() => view.actions.Increment.run()}
      >
        Add one
      </button>
      <Link to="/detail/one" replace={false}>
        Open detail
      </Link>
      <Link to="/">List</Link>
    </main>
  )
}
const ListScreen = () => <CounterScreen title="List" view={useScreen(List)} />
const DetailScreen = () => <CounterScreen title="Detail" view={useScreen(Detail)} />

const bridge = developmentBridge()
const root = document.getElementById("root")
if (root === null) {
  throw new Error("Missing root")
}
createRoot(root).render(
  <ReflexProvider host={host} bridge={bridge}>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ListScreen />} />
        <Route path="/detail/:id" element={<DetailScreen />} />
      </Routes>
    </BrowserRouter>
  </ReflexProvider>,
)
