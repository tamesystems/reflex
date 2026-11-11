import { Screen, defineApp, defineService, defineFixture } from "@reflex/effect"
import { createReflex } from "@reflex/react"
import { createReflexRouter } from "@reflex/react-router"
import * as Schema from "effect/Schema"
import { Detail, type List } from "../src/app.ts"
import { reflex } from "../src/routes.ts"

class Count extends Screen("Count", {
  state: Schema.Struct({ count: Schema.Number }),
  params: { count: Schema.NumberFromString },
  initial: ({ count }) => ({ count }),
}) {}
const CountLive = Count.implement({
  actions: (a) => ({
    Set: a.reduce({ input: Schema.NumberFromString, reducer: (count) => ({ count }) }),
  }),
})
const Service = defineService({
  name: "Metrics",
  state: Schema.Number,
  initial: () => 0,
  actions: (a) => ({ Increment: a.reduce({ reducer: (_, state) => state + 1 }) }),
})
const Fixture = defineFixture({
  name: "Fixture",
  state: Schema.Number,
  initial: () => 0,
  actions: () => ({}),
})
const app = defineApp({
  name: "bindings",
  screens: [CountLive],
  services: [Service],
  fixtures: [Fixture],
})
const core = createReflex(app)
const router = createReflexRouter(app, { Count: "/:count" })
class Foreign extends Screen("Count", { state: Schema.String, initial: () => "foreign" }) {}

export function useTypedBindings() {
  const view = core.useScreen(Count)
  const count: number = view.state.count
  void count
  void view.actions.Set.run("2")
  // @ts-expect-error Inputs use the encoded codec type.
  void view.actions.Set.run(2)
  // @ts-expect-error Published state is readonly.
  view.state.count = 2
  // @ts-expect-error Same-name foreign constructors fail membership.
  core.useScreen(Foreign)
  // @ts-expect-error Unknown contracts fail screen membership.
  core.useScreen(Detail)
  // @ts-expect-error Fixtures are not screens.
  core.useScreen(Fixture)
  // @ts-expect-error Screens are not ambient services.
  core.useService(Count)
  // @ts-expect-error Fixtures are not services.
  core.useService(Fixture)
  const service = core.useService(Service)
  if (service.status === "ready") {
    const state: number = service.state
    void state
  }
  const feature = core.from(Count)
  const selected: number = feature.useNodeState((state) => state.count)
  void selected
  void feature.useAction("Set").run("3")
  // @ts-expect-error Narrowed action inputs stay encoded.
  void feature.useAction("Set").run(3)
  // @ts-expect-error Narrowed action names are checked.
  feature.useAction("Missing")
  void core
    .useSession()
    .reset("default")
    .then((next) => next.reset("default"))
  // @ts-expect-error Scenario names are closed.
  void core.useSession().reset("missing")
}
// @ts-expect-error Required placeholders must appear.
createReflexRouter(app, { Count: "/" })
// @ts-expect-error Unknown placeholders require a mapping.
createReflexRouter(app, { Count: "/:id" })
// @ts-expect-error Repeated placeholders are rejected.
createReflexRouter(app, { Count: "/:count/:count" })
// @ts-expect-error Excluded grammar needs routeCodec.
createReflexRouter(app, { Count: "/:count?" })
const dynamic: string = "/:count"
// @ts-expect-error Paths must be literals.
createReflexRouter(app, { Count: dynamic })
createReflexRouter(app, { Count: { pathname: "/:id", params: { count: "id" } } })
// @ts-expect-error Mapping names must be schema fields.
createReflexRouter(app, { Count: { pathname: "/:count", params: { missing: "id" } } })
// @ts-expect-error Every screen needs a registration.
createReflexRouter(app, {})
// @ts-expect-error href takes encoded params.
router.href(Count, { count: 2 })
router.href(Count, { count: "2" })
// @ts-expect-error Rendering source is required.
router.routes({ Count: {} })
router.routes({
  Count: { Component: () => null, loader: ({ params }) => params.count, handle: "host data" },
})
// @ts-expect-error Reflex owns the path.
router.routes({ Count: { Component: () => null, path: "/other" } })
// @ts-expect-error Every screen needs a view.
reflex.routes({ List: { Component: () => null } })
// @ts-expect-error Required params must accompany a contract.
const missing = <reflex.Link to={Detail} />
// @ts-expect-error Links take contracts.
const named = <reflex.Link to="Detail" params={{ id: "one" }} />
declare const union: typeof List | typeof Detail
// @ts-expect-error A union destination cannot carry only one member's params.
const uncorrelated = <reflex.Link to={union} params={{ id: "one" }} />
// @ts-expect-error href preserves destination/params correlation.
reflex.href(union, { id: "one" })
const hostProps = (
  <reflex.Link
    to={Detail}
    params={{ id: "one" }}
    title="Detail"
    aria-label="Open"
    state={{ source: "test" }}
    onClick={(event) => {
      event.preventDefault()
    }}
  />
)
void missing
void named
void uncorrelated
void hostProps

// @ts-expect-error from accepts contracts rather than selected implementations.
core.from(CountLive)
export const useInvalidImplementation = () => {
  // @ts-expect-error useScreen accepts contracts rather than selected implementations.
  core.useScreen(CountLive)
}
// @ts-expect-error from checks membership just like useScreen.
core.from(Detail)
// @ts-expect-error Registration keys must be exact, including widened input objects.
createReflexRouter(app, { Count: "/:count", Typo: "/ignored" })
const FirstPath = Screen.define("FirstPath", {
  state: Schema.Number,
  initial: () => 0,
  actions: () => ({}),
})
const SecondPath = Screen.define("SecondPath", {
  state: Schema.Number,
  initial: () => 0,
  actions: () => ({}),
})
const pathApp = defineApp({ name: "paths", screens: [FirstPath, SecondPath] })
// @ts-expect-error Ordinary literal paths must be unique.
createReflexRouter(pathApp, { FirstPath: "/", SecondPath: "/" })
