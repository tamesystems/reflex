import { Suspense } from "react"
import { developmentBridge } from "@reflex/live/vite"
import type { ScreenView } from "@reflex/react"
import { createReflexRouter } from "@reflex/react-router"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Link, Route, Routes } from "react-router"
import { List, Detail, host } from "./host.ts"

const { Provider, useScreen, useScreenSuspense } = createReflexRouter(host, {
  List: "/",
  Detail: { pathname: "/detail/:id", params: { id: "id" } },
})
const CounterScreen = ({
  title,
  view,
}: {
  readonly title: string
  readonly view: ScreenView<typeof List>
}) => {
  if (view.status === "pending") {
    return <p>Loading…</p>
  }
  return (
    <main>
      <h1>{title}</h1>
      <p>Count: {view.state.count}</p>
      {title === "Detail" && <p>Item: {view.state.id}</p>}
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
const DetailScreen = () => <CounterScreen title="Detail" view={useScreenSuspense(Detail)} />

const bridge = developmentBridge()
const root = document.getElementById("root")
if (root === null) {
  throw new Error("Missing root")
}
createRoot(root).render(
  <Provider bridge={bridge}>
    <BrowserRouter>
      <Suspense fallback={<p>Loading…</p>}>
        <Routes>
          <Route path="/" element={<ListScreen />} />
          <Route path="/detail/:id" element={<DetailScreen />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </Provider>,
)
