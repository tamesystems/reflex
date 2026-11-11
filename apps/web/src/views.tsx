import { List, Detail } from "./app.ts"
import { useScreenStatus, Link, useScreen } from "./routes.ts"

export function ListView() {
  const view = useScreenStatus(List)
  if (view.status === "error") {
    return (
      <button
        type="button"
        onClick={() => {
          void view.retry()
        }}
      >
        Retry: {view.error.message}
      </button>
    )
  }
  if (view.status === "pending") {
    return <p>Loading…</p>
  }
  return (
    <main>
      <h1>List</h1>
      <p>Count: {view.state.count}</p>
      <button
        type="button"
        disabled={!view.actions.Increment.available}
        onClick={() => {
          void view.actions.Increment.run()
        }}
      >
        Add one
      </button>
      <Link to={Detail} params={{ id: "one" }}>
        Open detail
      </Link>
    </main>
  )
}
export function DetailView() {
  const { state, actions } = useScreen(Detail)
  return (
    <main>
      <h1>Detail {state.id}</h1>
      <p>Count: {state.count}</p>
      <button
        type="button"
        disabled={!actions.Increment.available}
        onClick={() => {
          void actions.Increment.run()
        }}
      >
        Add one
      </button>
      <Link to={List}>List</Link>
    </main>
  )
}
