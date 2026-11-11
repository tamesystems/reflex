import { expect } from "bun:test"
import { Screen, defineApp, defineNavigation } from "@reflex/effect"
import { defineStoreApp, defineStoreNode, standardInput } from "@reflex/runtime"
import { createRuntime, mountOwned } from "@reflex/runtime/advanced"
import { createReflex } from "@reflex/react"
import { createReflexRouter } from "@reflex/react-router"
import { createReflexExpo } from "@reflex/expo"
import { createTestApp, explore } from "@reflex/test"
import { createProtocolTestSession } from "@reflex/test/advanced"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

class Detail extends Screen("Detail", {
  state: Schema.Struct({ id: Schema.String, count: Schema.Number }),
  params: { id: Schema.String },
  initial: ({ id }) => ({ id, count: 0 }),
}) {}
const Nav = defineNavigation({ Detail })
const save = (
  input: number,
  { state }: import("@reflex/effect").EffectContext<typeof Detail.state.Type>,
) => state.update((s) => ({ ...s, count: input }))
const detail = Detail.implement({
  actions: (a) => ({
    Save: a({ input: Schema.Number, handler: save }),
    Back: a.navigates({ handler: () => Nav.back }),
    Scoped: a({ handler: () => Effect.asVoid(Effect.forkScoped(Effect.void)) }),
    SecretError: a({
      error: Schema.Redacted(Schema.String),
      handler: () => Effect.fail(Redacted.make("private")),
    }),
  }),
})
export const app = defineApp({
  name: "capabilities",
  navigation: Nav.implement([detail], { initial: { screen: Detail, params: { id: "first" } } }),
})
const { Provider, useScreen, useScreenStatus, Link, href, from } = createReflexRouter(app, {
  Detail: "/:id",
})
const feature = from(Detail)
export function DetailView() {
  const { state, actions } = useScreen(Detail)
  const count = feature.useNodeState((s) => s.count)
  const saveAction = feature.useAction("Save")
  return (
    <Provider>
      <Link
        to={Detail}
        params={{ id: state.id }}
        title={href(Detail, { id: state.id })}
        onClick={() => {
          void saveAction.run(count + 1)
          void actions.Back.run()
        }}
      >
        Detail
      </Link>
    </Provider>
  )
}
export function OptionalStatus() {
  return useScreenStatus(Detail).status
}
export const expo = createReflexExpo(app, { Detail: { pathname: "/[id]" } })
const Counter = defineStoreNode({
  name: "Counter",
  store: () => createStore(() => ({ count: 0 })),
  actions: (a) => ({
    Set: a({
      input: standardInput(z.number(), { type: "number" }),
      handler: (count, { store }) => store.setState({ count }),
    }),
  }),
})
export const storeApp = defineStoreApp({ name: "overrides", services: [Counter] }).withScenarios({
  seeded: { stores: [Counter.withStore(() => createStore(() => ({ count: 5 })))] },
})
export const { useService } = createReflex(storeApp)
export async function journey() {
  await using session = await createTestApp(app)
  const node = await session.focused(Detail)
  const outcome = await node.actions.SecretError.run()
  if (outcome.status === "error") {
    const marker: "<redacted>" = outcome.error
    expect(marker).toBe("<redacted>")
  }
  const refused = await node.actions.Back.expectRefusal()
  expect(refused.reason).toBeString()
}
export async function storeOverride() {
  await using session = await createTestApp(storeApp, { scenario: "seeded" })
  const counter = await session.node(Counter)
  expect(await counter.state()).toEqual({ count: 5 })
}
export async function advanced() {
  await using runtime = await createRuntime(storeApp)
  const node = mountOwned(runtime, Counter)
  const stop = node.changes.subscribe((state) => {
    const count: number = state.count
    void count
  })
  await node.actions.Set.run(node.state.count + 1)
  stop()
  await node.dispose()
}
export async function exploreCounter() {
  await explore(storeApp, {
    steps: 10,
    inputs: { Counter: { Set: [1, 2] } },
    invariants: { Counter: (state) => (state.count < 0 ? "Negative count" : undefined) },
  })
}
export async function protocol() {
  await using session = await createProtocolTestSession(storeApp)
  await session.request("app.dispatch", { action: 123 })
  await session.request("app.wait", { operationId: "missing" })
  expect(session.events().map((event) => event.type)).toEqual([])
}
const HostDetail = defineStoreNode({
  name: "HostDetail",
  params: z.object({ id: z.string() }),
  store: ({ id }) => createStore(() => ({ id })),
  actions: () => ({}),
})
export async function openStoreRoute() {
  const app = defineStoreApp({ name: "host-routed", screens: [HostDetail] })
  await using session = await createTestApp(app)
  const detail = await session.open(HostDetail, { id: "one" })
  expect(await detail.state()).toEqual({ id: "one" })
}
