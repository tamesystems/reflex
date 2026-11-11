import { createReflexRouter } from "@reflex/react-router"
import { defineApp, defineNavigation, Screen } from "@reflex/effect"
import * as Schema from "effect/Schema"
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
class Contract extends Screen("Detail", {
  state: Schema.NumberFromString,
  params: { a: Schema.String, b: Schema.String },
  initial: () => 0,
}) {}
const Impl = Contract.implement({ actions: () => ({}) })
const nav = defineNavigation({ Detail: Contract })
const app = defineApp({
  name: "web",
  navigation: nav.implement([Impl], {
    initial: { screen: Contract, params: { a: "a", b: "b" } },
  }),
})
// @ts-expect-error URL targets must be unique.
createReflexRouter(app, { Detail: { pathname: "/detail/:id", params: { a: "id", b: "id" } } })
class Foreign extends Screen("Detail", {
  state: Schema.String,
  params: { a: Schema.String, b: Schema.String },
  initial: () => "foreign",
}) {}
const router = createReflexRouter(app, {
  Detail: { pathname: "/detail/:a/:b", params: { a: "a", b: "b" } },
})
export const useForeign = () => {
  // @ts-expect-error Same-name contracts with different state schemas cannot fill the hook.
  router.useScreen(Foreign)
}
