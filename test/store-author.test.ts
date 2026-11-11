import { describe, expect, test } from "bun:test"
import { defineStoreApp, defineStoreNode, standardInput } from "@reflex/runtime"
import { createRuntime, mountOwned } from "@reflex/runtime/advanced"
import {
  createController,
  type AppHost,
  type Controller,
  systemTimers,
} from "@reflex/runtime/internal"
import type { RuntimeEvent } from "@reflex/protocol"
import { createStore, type StoreApi } from "zustand/vanilla"
import { z } from "zod"
import { LiveSessions } from "../packages/live/src/live-sessions.ts"
import { createLiveController } from "../packages/live/src/live-controller.ts"

const Counter = defineStoreNode({
  name: "Counter",
  store: () => createStore(() => ({ count: 0 })),
  actions: (a) => ({
    Set: a({ input: z.number(), handler: (count, { store }) => store.setState({ count }) }),
    Reject: a({
      error: z.object({ _tag: z.literal("Rejected"), message: z.string() }),
      handler: (_, { fail }) => fail({ _tag: "Rejected", message: "try again" }),
    }),
    InvalidFailure: a({
      error: z.number(),
      handler: (_, { fail }) => fail("wrong" as unknown as number),
    }),
    Undeclared: a({
      handler: () => {
        throw new Error("undeclared")
      },
    }),
    DateError: a({
      error: z.date(),
      projectError: (date) => date.toISOString(),
      handler: (_, { fail }) => fail(new Date("2026-01-01T00:00:00.000Z")),
    }),
    Encoded: a({
      error: z.string().transform(Number),
      projectError: (n) => String(n),
      handler: (_, { fail }) => fail(42),
    }),
  }),
})
const app = defineStoreApp({ name: "author", services: [Counter] }).withScenarios({
  seeded: { stores: [Counter.withStore(() => createStore(() => ({ count: 5 })))] },
})
const openers: readonly [string, (host: AppHost) => Promise<Controller>][] = [
  ["session", (host) => createController(host)],
  [
    "live",
    async (host) => {
      const sessions = new LiveSessions({ timers: systemTimers, onBackgroundError: () => {} })
      const release = sessions.open(host, undefined)
      await sessions.settled()
      const controller = createLiveController(sessions, () => {})
      return {
        ...controller,
        request: controller.request.bind(controller),
        subscribe: controller.subscribe.bind(controller),
        close: async () => {
          await controller.close()
          release()
        },
      }
    },
  ],
]
describe.each(openers)("store author through %s controller", (_, open) => {
  test("outcomes, validated failures, defects, JSON Schema and scenario overrides", async () => {
    const controller = await open(app)
    try {
      const tree = await controller.request("app.inspect", { tree: true })
      const node = tree.tree?.[0]
      expect(node?.type).toBe("service")
      const set = await controller.request("app.dispatch", { action: "Set", input: 2, await: true })
      expect(set.status).toBe("completed")
      expect(
        (await controller.request("app.inspect", { name: "Counter" })).node?.actions.Set
          ?.inputSchema,
      ).toMatchObject({ type: "number" })
      expect(
        await controller.request("app.dispatch", { action: "Reject", await: true }),
      ).toMatchObject({
        status: "failed",
        error: { tag: "Rejected", defect: false, data: { _tag: "Rejected", message: "try again" } },
      })
      for (const action of ["InvalidFailure", "Undeclared"]) {
        expect(await controller.request("app.dispatch", { action, await: true })).toMatchObject({
          status: "failed",
          error: { tag: "Defect", defect: true },
        })
      }
      expect(
        await controller.request("app.dispatch", { action: "Encoded", await: true }),
      ).toMatchObject({ status: "failed", error: { defect: false, data: "42" } })
      await controller.request("app.reset", { scenario: "seeded" })
      expect((await controller.request("app.inspect", { name: "Counter" })).node?.state).toEqual({
        count: 5,
      })
    } finally {
      await controller.close()
    }
  })
  test("reset revokes a suspended handler before it can write or notify", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const resumed = Promise.withResolvers<void>()
    const stores: StoreApi<{ count: number }>[] = []
    const Slow = defineStoreNode({
      name: "Slow",
      store: () => {
        const store = createStore(() => ({ count: 0 }))
        stores.push(store)
        return store
      },
      actions: (a) => ({
        Late: a({
          handler: async (_, { store }) => {
            const write = store.setState
            entered.resolve()
            await release.promise
            try {
              write({ count: 99 })
            } finally {
              resumed.resolve()
            }
          },
        }),
      }),
    })
    const controller = await open(defineStoreApp({ name: "late", services: [Slow] }))
    const events: RuntimeEvent[] = []
    try {
      await controller.subscribe((event) => events.push(event))
      const operation = await controller.request("app.dispatch", { action: "Late" })
      expect(operation.status).toBe("running")
      await entered.promise // Establish that the old handler reached its suspension point.
      let notifications = 0
      const stop = stores[0]?.subscribe(() => notifications++)
      await controller.request("app.reset", {})
      const afterReset = events.length
      release.resolve()
      await resumed.promise
      await Promise.resolve()
      expect(stores[0]?.getState()).toEqual({ count: 0 })
      expect(notifications).toBe(0)
      expect(events.slice(afterReset)).toEqual([])
      expect((await controller.request("app.inspect", { name: "Slow" })).node?.state).toEqual({
        count: 0,
      })
      stop?.()
    } finally {
      release.resolve()
      await controller.close()
    }
  })
})

test("owned store handles expose typed outcomes and scenario state", async () => {
  await using runtime = await createRuntime(app, { scenario: "seeded" })
  const counter = mountOwned(runtime, Counter)
  expect(counter.state.count).toBe(5)
  const changes: number[] = []
  const stop = counter.changes.subscribe((state) => changes.push(state.count))
  expect(counter.actions.Set.available).toBe(true)
  expect(await counter.actions.Set.run(8)).toEqual({ status: "completed" })
  expect(changes).toEqual([8])
  expect(await counter.actions.Reject.run()).toEqual({
    status: "error",
    error: { _tag: "Rejected", message: "try again" },
  })
  expect(await counter.actions.Encoded.run()).toEqual({ status: "error", error: "42" })
  expect(await counter.actions.DateError.run()).toEqual({
    status: "error",
    error: "2026-01-01T00:00:00.000Z",
  })
  stop()
  await counter.dispose()
  const remounted = mountOwned(runtime, Counter)
  expect(remounted.state.count).toBe(5)
})

test("parameter inference and scenario factories retain decoded route params", async () => {
  const Detail = defineStoreNode({
    name: "Detail",
    params: z.object({ id: z.string() }),
    store: ({ id }) => createStore(() => ({ id })),
    actions: (a) => ({
      Set: a({ input: z.string(), handler: (id, { store }) => store.setState({ id }) }),
    }),
  })
  const routes = defineStoreApp({ name: "routes", screens: [Detail] }).withScenarios({
    seeded: { stores: [Detail.withStore(({ id }) => createStore(() => ({ id: `seed-${id}` })))] },
  })
  await using runtime = await createRuntime(routes, { scenario: "seeded" })
  const node = mountOwned(runtime, Detail, { id: "one" })
  expect(node.state).toEqual({ id: "seed-one" })
  expect(node.actions.Set.available).toBe(true)
  expect(await node.actions.Set.run("changed")).toEqual({ status: "completed" })
  const second = mountOwned(runtime, Detail, { id: "two" })
  expect(second.state.id).toBe("seed-two")
  expect(node.state.id).toBe("changed")
})

test("composition rejects duplicate names, roles, ambient params and foreign overrides", () => {
  expect(() =>
    // @ts-expect-error Runtime validation for JavaScript callers.
    defineStoreApp({ name: "duplicate", screens: [Counter], services: [Counter] }),
  ).toThrow("Duplicate definition name")
  // @ts-expect-error Runtime role validation.
  expect(() => defineStoreApp({ name: "role", services: [{ name: "Fake" }] })).toThrow(
    "defineStoreApp accepts only stores",
  )
  const Params = defineStoreNode({
    name: "Params",
    params: z.object({ id: z.string() }),
    store: ({ id }) => createStore(() => ({ id })),
    actions: () => ({}),
  })
  // @ts-expect-error Runtime ambient params validation.
  expect(() => defineStoreApp({ name: "ambient", services: [Params] })).toThrow(
    "Ambient services must not require params",
  )
  expect(() =>
    defineStoreApp({ name: "empty" }).withScenarios({
      // @ts-expect-error Runtime foreign override validation.
      seeded: { stores: [Counter.withStore(() => createStore(() => ({ count: 1 })))] },
    }),
  ).toThrow("Scenario stores must belong to this app")
})

test("unprojected rich state has the composition diagnostic on startup", async () => {
  const Rich = defineStoreNode({
    name: "Rich",
    store: () => createStore(() => ({ date: new Date() })),
    actions: () => ({}),
  })
  // @ts-expect-error Runtime validation for untyped callers.
  const rich = defineStoreApp({ name: "rich", services: [Rich] })
  await expect(rich.start("default", { sessionId: "rich" })).rejects.toThrow(
    "Store Rich state must be JSON; provide project",
  )
})

test("opaque validators require and use an explicit JSON Schema", async () => {
  const validator = {
    "~standard": {
      version: 1 as const,
      vendor: "opaque",
      validate: (value: unknown) =>
        typeof value === "number" ? { value } : { issues: [{ message: "Expected number" }] },
    },
  }
  expect(() => standardInput(validator)).toThrow("no Standard JSON Schema converter")
  const Opaque = defineStoreNode({
    name: "Opaque",
    store: () => createStore(() => 0),
    actions: (a) => ({
      Set: a({
        input: standardInput(validator, { type: "number" }),
        handler: (n, { store }) => store.setState(n),
      }),
    }),
  })
  await using runtime = await createRuntime(defineStoreApp({ name: "opaque", services: [Opaque] }))
  const opaque = mountOwned(runtime, Opaque)
  expect(await opaque.actions.Set.run(3)).toEqual({ status: "completed" })
  expect(opaque.state).toBe(3)
})
