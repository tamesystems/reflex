import * as React from "react"
import { createRoot } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { createReflexRouter } from "@reflex/react-router"
import { createReflex } from "@reflex/react"
import { Screen, defineApp, defineService } from "@reflex/effect"
import * as Schema from "effect/Schema"
import * as Effect from "effect/Effect"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

class Api extends Context.Service<Api, { readonly value: number }>()("probe/Api") {}
let mounts = 0
class Probe extends Screen("Probe", {
  params: { id: Schema.String },
  state: Schema.Struct({ id: Schema.String, count: Schema.Number, label: Schema.String }),
  initial: ({ id }) => {
    if (++mounts === 1) {
      throw new Error("Build failed once")
    }
    return { id, count: 0, label: "initial" }
  },
}) {}
const ProbeLive = Probe.implement({
  actions: (a) => ({
    Read: a({
      handler: (_, { state }) =>
        Effect.gen(function* () {
          const api = yield* Api
          yield* state.update((s) => ({ ...s, count: api.value }))
        }),
    }),
    Label: a.reduce({ reducer: (_, s) => ({ ...s, label: "changed" }) }),
  }),
})
const Metrics = defineService({
  name: "Metrics",
  state: Schema.Number,
  initial: () => 0,
  actions: (a) => ({ Increment: a.reduce({ reducer: (_, n) => n + 1 }) }),
})
const app = defineApp({
  name: "probe",
  screens: [ProbeLive],
  services: [Metrics],
  layer: Layer.succeed(Api, { value: 7 }),
})
const instrumented = app.withScenarios({ alternate: {} })
const reflex = createReflexRouter(app, { Probe: "/:id" })
const feature = reflex.from(ProbeLive)
let selectionRenders = 0
const Selected = React.memo(function Selected() {
  const count = feature.useNodeState((s) => s.count)
  return (
    <p>
      Selected: {count}; renders: {++selectionRenders}
    </p>
  )
})
let originalControls: ReturnType<typeof reflex.useSession> | undefined
function View() {
  const status = reflex.useScreenStatus(Probe)
  const view = reflex.useScreen(Probe)
  const service = reflex.useService(Metrics)
  const session = reflex.useSession()
  const [stale, setStale] = React.useState("")
  React.useEffect(() => {
    originalControls ??= session
  }, [session])
  return (
    <main>
      <h1>Probe {view.state.id}</h1>
      <p>
        Builds: {mounts}; status: {status.status}; shared:{" "}
        {status.state === view.state ? "yes" : "no"}
      </p>
      <p>
        Count: {view.state.count}; label: {view.state.label}
      </p>
      <Selected />
      <button
        type="button"
        onClick={() => {
          void view.actions.Read.run()
        }}
      >
        Read session service
      </button>
      <button
        type="button"
        onClick={() => {
          void view.actions.Label.run()
        }}
      >
        Change label
      </button>
      {service.status === "ready" && (
        <button
          type="button"
          onClick={() => {
            void service.actions.Increment.run()
          }}
        >
          Metrics: {service.state}
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          void session.reset("default")
        }}
      >
        Reset probe
      </button>
      <button
        type="button"
        onClick={() => {
          void originalControls?.reset("default").catch((error: unknown) => setStale(String(error)))
        }}
      >
        Use stale controls
      </button>
      <p>{stale}</p>
    </main>
  )
}
const router = createMemoryRouter(
  reflex.routes({ Probe: { lazy: { Component: async () => View } } }),
  {
    initialEntries: ["/one"],
  },
)
let opened = 0
let closed = 0
const bridge = () => {
  opened++
  return () => {
    closed++
  }
}
function Harness() {
  const [visible, setVisible] = React.useState(true)
  const [lifecycle, setLifecycle] = React.useState("")
  return (
    <>
      <button type="button" onClick={() => setVisible(false)}>
        Unmount host
      </button>
      <button type="button" onClick={() => setLifecycle(`Opened: ${opened}; closed: ${closed}`)}>
        Read lifecycle
      </button>
      <p>{lifecycle}</p>
      {visible && (
        <reflex.Provider app={instrumented} bridge={bridge}>
          <RouterProvider router={router} />
        </reflex.Provider>
      )}
    </>
  )
}
const startup = createReflex({
  name: "failure",
  screens: {},
  defaultScenario: "default",
  scenarioNames: ["default"] as const,
  scenarios: [{ name: "default", virtualTime: false }],
  start: async () => {
    throw new Error("Startup failed")
  },
})
class StartupBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? <p>Startup reached boundary</p> : this.props.children
  }
}
const root = document.getElementById("root")
if (!root) {
  throw new Error("Missing root")
}
createRoot(root).render(
  <>
    <React.StrictMode>
      <Harness />
    </React.StrictMode>
    <StartupBoundary>
      <startup.Provider fallback={<p>Starting failure probe</p>}>Unreachable</startup.Provider>
    </StartupBoundary>
  </>,
)
