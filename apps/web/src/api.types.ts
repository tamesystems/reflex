import { createReflexRouter } from "@reflex/react-router"
import { defineApp, defineNavigation, defineScreen } from "@reflex/effect"
import * as Schema from "effect/Schema"
import * as Layer from "effect/Layer"
import { host, Detail } from "./host.ts"
// @ts-expect-error Registrations must cover every screen.
createReflexRouter(host, { List: "/" })
const bound = createReflexRouter(host, {
  List: "/",
  Detail: { pathname: "/detail/:id", params: { id: "id" } },
})
export const useContracts = () => {
  const view = bound.useScreen(Detail)
  if (view.status === "ready") {
    const id: string = view.state.id
    void id
    void view.actions.Increment.run()
  }
  // @ts-expect-error Bound session controls check scenario names.
  void bound.useSession().reset("missing")
}
const token = Symbol("detail")
const Contract = defineScreen({
  identity: token,
  name: "Detail",
  state: Schema.NumberFromString,
  params: Schema.Struct({ a: Schema.String, b: Schema.String }),
  initial: () => 0,
})
const Impl = Contract.implement({ actions: () => ({}) })
const nav = defineNavigation("web/types", { Detail: Contract })
const app = defineApp({
  name: "web",
  navigation: nav.implement(
    { Detail: Impl },
    { initial: { route: "Detail", params: { a: "a", b: "b" } } },
  ),
  scenarios: { default: { layer: Layer.empty } },
  defaultScenario: "default",
})
// @ts-expect-error URL targets must be unique.
createReflexRouter(app, { Detail: { pathname: "/detail/:id", params: { a: "id", b: "id" } } })
const foreign = Symbol("foreign")
const Foreign = defineScreen({
  identity: foreign,
  name: "Detail",
  state: Schema.NumberFromString,
  params: Schema.Struct({ a: Schema.String, b: Schema.String }),
  initial: () => 0,
})
const router = createReflexRouter(app, {
  Detail: { pathname: "/detail/:a/:b", params: { a: "a", b: "b" } },
})
export const useForeign = () => {
  // @ts-expect-error Same-name contracts with different explicit identities cannot fill the hook.
  router.useScreen(Foreign)
}
