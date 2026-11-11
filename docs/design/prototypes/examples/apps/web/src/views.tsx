import { List, Detail } from "./app.ts"
import { reflex } from "./routes.ts"

export function ListView() {
  const view = reflex.useScreen(List)
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
      <reflex.Link to={Detail} params={{ id: "one" }}>
        Open detail
      </reflex.Link>
    </main>
  )
}
export function DetailView() {
  const { state, actions } = reflex.useScreenSuspense(Detail)
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
      <reflex.Link to={List}>List</reflex.Link>
    </main>
  )
}
