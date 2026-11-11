import { defineStoreNode, defineStoreApp, standardInput } from "@reflex/runtime"
import { createRuntime, mountOwned } from "@reflex/runtime/advanced"
import { createStore } from "zustand/vanilla"
import { z } from "zod"

const Counter = defineStoreNode({
  name: "Counter",
  store: () => createStore(() => ({ count: 0 })),
  actions: (a) => ({
    Add: a({ input: z.number(), handler: (count, { store }) => store.setState({ count }) }),
    Empty: a({
      handler: (_, ctx) => {
        // @ts-expect-error No failure helper without an error declaration.
        ctx.fail("no")
      },
    }),
    Encoded: a({
      error: z.string().transform(Number),
      projectError: (n) => String(n),
      handler: (_, { fail }) => {
        // @ts-expect-error Projected failures take the decoded error type.
        fail("wrong")
      },
    }),
    // @ts-expect-error Store errors must publish JSON.
    Rich: a({ error: z.date(), handler: (_, { fail }) => fail(new Date()) }),
    // @ts-expect-error Store handlers cannot return navigation commands.
    Navigate: a({ handler: () => ({ kind: "navigation" as const }) }),
    // @ts-expect-error Input must encode JSON.
    Big: a({ input: z.bigint(), handler: () => {} }),
  }),
})
const DateNode = defineStoreNode({
  name: "Date",
  store: () => createStore(() => ({ now: new Date() })),
  actions: () => ({}),
})
// @ts-expect-error Store Date state must be JSON; provide project.
defineStoreApp({ name: "dates", services: [DateNode] })
const FunctionNode = defineStoreNode({
  name: "Function",
  store: () => createStore(() => ({ f: () => 1 })),
  actions: () => ({}),
})
// @ts-expect-error Functions are not JSON state.
defineStoreApp({ name: "functions", services: [FunctionNode] })
// @ts-expect-error Duplicate definition names.
defineStoreApp({ name: "duplicates", services: [Counter, Counter] })
// @ts-expect-error Duplicate names across roles.
defineStoreApp({ name: "duplicates", screens: [Counter], services: [Counter] })
const Detail = defineStoreNode({
  name: "Detail",
  params: z.object({ id: z.string() }),
  store: ({ id }) => createStore(() => ({ id })),
  actions: () => ({}),
})
// @ts-expect-error Ambient services cannot require params.
defineStoreApp({ name: "ambient", services: [Detail] })
const BigParams = defineStoreNode({
  name: "BigParams",
  params: z.object({ id: z.bigint() }),
  store: ({ id }) => createStore(() => ({ id: String(id) })),
  actions: () => ({}),
})
// @ts-expect-error Params must encode JSON.
defineStoreApp({ name: "params", screens: [BigParams] })
// @ts-expect-error Overrides retain the store type.
Counter.withStore(() => createStore(() => "wrong"))
defineStoreApp({ name: "empty" }).withScenarios({
  // @ts-expect-error Overrides must belong to the app.
  seeded: { stores: [Counter.withStore(() => createStore(() => ({ count: 5 })))] },
})
// @ts-expect-error Non-store definitions are rejected.
defineStoreApp({ name: "roles", services: [{ name: "fake" }] })
const app = defineStoreApp({ name: "typed", screens: [Detail], services: [Counter] }).withScenarios(
  { seeded: { stores: [Counter.withStore(() => createStore(() => ({ count: 5 })))] } },
)
// @ts-expect-error Scenario names are literal.
app.withScenarios({ other: {} }, { defaultScenario: "missing" })
export async function owned() {
  // @ts-expect-error Runtime scenario names retain the application contract.
  await createRuntime(app, { scenario: "missing" })
  await using runtime = await createRuntime(app, { scenario: "seeded" })
  // @ts-expect-error Parameterised stores require params.
  mountOwned(runtime, Detail)
  const detail = mountOwned(runtime, Detail, { id: "one" })
  const id: string = detail.state.id
  const counter = mountOwned(runtime, Counter)
  const outcome = await counter.actions.Encoded.run()
  if (outcome.status === "error") {
    const published: string = outcome.error
    void published
  }
  const count: number = counter.state.count
  await counter.actions.Add.run(count)
  // @ts-expect-error The action input retains its inferred number type.
  await counter.actions.Add.run("wrong")
  void id
}
const Opaque = standardInput(z.number(), { type: "number" })
export const opaque = defineStoreNode({
  name: "Opaque",
  store: () => createStore(() => 0),
  actions: (a) => ({ Set: a({ input: Opaque, handler: (n, { store }) => store.setState(n) }) }),
})
