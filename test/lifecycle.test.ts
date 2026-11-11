import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
/** Regressions from adversarial review: sessions, waits, and connections ending. */
import { afterEach, expect, spyOn, test } from "bun:test"
import { createEffectHost, defineCapability } from "@reflex/effect/internal"
import {
  type ActionsOf,
  type Capability,
  NavigationRefused,
  NoParams,
} from "@reflex/effect/internal"
import { defineNavigationFactories, mountOwned as mount, Registry } from "@reflex/effect/internal"
import {
  BATCH_LARGE_REPLY_CHARACTERS_MAX,
  defined,
  ErrorCode,
  EVENT_NOTIFICATION,
  FRAME_CHARACTERS_MAX,
  HELD_EVENT_CHARACTERS_MAX,
  NAVIGATION_STACK_DEPTH_MAX,
  NODE_STATE_CHARACTERS_MAX,
  OUTSTANDING_CONTROL_REQUESTS_MAX,
  ProtocolError,
  RETAINED_EVENTS_MAX,
  type RuntimeEvent,
  toNodeId,
  toOperationId,
  UNFINISHED_SCREEN_WORK_MAX,
  UNFINISHED_SESSIONS_MAX,
  WAIT_MATCH_CHARACTERS_MAX,
} from "@reflex/protocol"
import { createConnection, createLineReader, createLoopbackClient } from "@reflex/rpc"
import {
  type AppHost,
  type AppSession,
  awaitSession,
  type Controller,
  createController,
  type Timers,
} from "@reflex/runtime/internal"
import { createTestApp, createTestAppPool, nextTurn, waitUntil } from "@reflex/test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import inventoryDefinition from "../examples/inventory/src/scenarios.ts"
const inventory = inventoryDefinition[APP_HOST_ADAPTER]

const pool = createTestAppPool()
const controllers: Array<Controller> = []

afterEach(async () => {
  await pool.disposeAll()
  await Promise.allSettled(controllers.splice(0).map((controller) => controller.close()))
})

/** Time that only moves when a test says so, so that deadlines cannot race startup. */
const manualTimers = () => {
  const pending = new Set<() => void>()
  const timers: Timers = {
    setTimeout: (callback) => {
      pending.add(callback)
      return callback
    },
    clearTimeout: (handle) => {
      pending.delete(handle as () => void)
    },
  }
  const expire = () => {
    for (const callback of [...pending]) {
      pending.delete(callback)
      callback()
    }
  }
  return { timers, expire }
}

const openController: typeof createController = async (host, options) => {
  const controller = await createController(host, options)
  controllers.push(controller)
  return controller
}

/** Count live sessions on a real host. */
const counting = (host: AppHost) => {
  const stats = { live: 0, peak: 0 }
  const wrapped: AppHost = {
    ...host,
    start: async (name, options) => {
      const session = await host.start(name, options)
      stats.live++
      stats.peak = Math.max(stats.peak, stats.live)
      const dispose = session.dispose
      return {
        ...session,
        runtime: session.runtime,
        dispose: async () => {
          await dispose()
          stats.live--
        },
      } satisfies AppSession
    },
  }
  return { wrapped, stats }
}

const focused = <S, A extends ActionsOf<S>>(
  name: string,
  capability: Capability<S, A, never>,
  initial: S,
) =>
  createEffectHost({
    name,
    defaultScenario: "default",
    root: Layer.effectDiscard(
      Effect.gen(function* () {
        const node = yield* mount(capability, initial)
        const registry = yield* Registry
        registry.setFocus(node.id)
      }),
    ),
    scenarios: { default: { layer: Layer.empty } },
  })

test("concurrent resets leave exactly one session, one at a time", async () => {
  const { wrapped, stats } = counting(inventory)
  const controller = await openController(wrapped)
  await Promise.all([
    controller.request("app.reset", {}),
    controller.request("app.reset", { scenario: "empty-inventory" }),
    controller.request("app.reset", {}),
  ])
  expect(stats).toEqual({ live: 1, peak: 1 })
  await controller.close()
  expect(stats.live).toBe(0)
})

test("close during a reset cannot resurrect a session", async () => {
  const { wrapped, stats } = counting(inventory)
  const controller = await openController(wrapped)
  const reset = controller.request("app.reset", {})
  await Promise.allSettled([reset, controller.close()])
  await expect(controller.request("app.reset", {})).rejects.toMatchObject({
    code: ErrorCode.SessionClosed,
  })
  await expect(controller.request("app.inspect", {})).rejects.toMatchObject({
    code: ErrorCode.SessionClosed,
  })
  expect(stats.live).toBe(0)
})

test("a failed reset leaves the controller recoverable", async () => {
  let fail = false
  const flaky: AppHost = {
    ...inventory,
    start: (name, options) =>
      fail ? Promise.reject(new Error("no")) : inventory.start(name, options),
  }
  const controller = await openController(flaky)
  fail = true
  await expect(controller.request("app.reset", {})).rejects.toThrow("no")
  await expect(controller.request("app.inspect", {})).rejects.toMatchObject({
    code: ErrorCode.SessionClosed,
  })
  fail = false
  await controller.request("app.reset", {})
  await controller.request("app.wait", { focus: "InventoryList" })
  await controller.close()
})

test("handles and sessions from before a reset are rejected", async () => {
  const session = await pool.open(inventory)
  const { node, sessionId } = await session.inspect()
  await session.reset()

  await expect(
    session.client.request("app.dispatch", {
      nodeId: toNodeId(String(node?.id)),
      action: "OpenSettings",
      expectedRevision: Number(node?.revision),
    }),
  ).rejects.toMatchObject({ code: ErrorCode.NodeNotFound })
  await expect(
    session.client.request("app.dispatch", {
      action: "OpenSettings",
      sessionId,
    }),
  ).rejects.toMatchObject({ code: ErrorCode.StaleSession })
})

test("handles repeat across fresh controllers, so a trace can be replayed", async () => {
  const handleOfFreshApp = async () => {
    const session = await pool.open(inventory)
    return (await session.inspect()).node?.id
  }
  expect(await handleOfFreshApp()).toBe(await handleOfFreshApp())
})

test("sessions with different prefixes never share handles", async () => {
  const first = await openController(inventory, { sessionPrefix: "process-a" })
  const second = await openController(inventory, { sessionPrefix: "process-b" })
  const a = await first.request("app.describe", {})
  const b = await second.request("app.describe", {})
  expect(a.sessionId).not.toBe(b.sessionId)
})

// Test timeouts are far below these waits' own, so a wait that lingered would fail.
test("waits end promptly with the session rather than timing out", async () => {
  const controller = await openController(inventory)
  const surviving = controller
    .request("app.wait", { focus: "Never", timeoutMs: 60_000 })
    .catch((error: unknown) => error)
  await nextTurn()
  await controller.request("app.reset", {})
  expect(await surviving).toMatchObject({ code: ErrorCode.SessionClosed })

  const closing = controller
    .request("app.wait", { focus: "Never", timeoutMs: 60_000 })
    .catch((error: unknown) => error)
  await nextTurn()
  await controller.close()
  expect(await closing).toMatchObject({ code: ErrorCode.SessionClosed })
})

test("a wait ends with the connection that asked for it", async () => {
  const controller = await openController(inventory)
  const lifetime = new AbortController()
  const waiting = controller
    .request("app.wait", { focus: "Never", timeoutMs: 60_000 }, { signal: lifetime.signal })
    .catch((error: unknown) => error)
  await nextTurn()
  lifetime.abort()
  expect(await waiting).toMatchObject({ code: ErrorCode.SessionClosed })
})

test("closing a client rejects what it was waiting for", async () => {
  const controller = await openController(inventory)
  const client = createLoopbackClient(controller)
  const pending = client.request("app.wait", { focus: "Never", timeoutMs: 60_000 })
  client.close()
  await expect(pending).rejects.toThrow("closed")
  await expect(client.request("app.describe", {})).rejects.toThrow("closed")
})

test("a subscription still opening when the connection closes is ended", async () => {
  const controller = await openController(inventory)
  let release = () => {}
  const opening = new Promise<void>((resolve) => {
    release = resolve
  })
  let activeCount = 0
  const gated: Controller = {
    request: controller.request.bind(controller),
    close: () => controller.close(),
    subscribe: async (listener, options) => {
      activeCount++
      await opening
      const subscription = await controller.subscribe(listener, options)
      return {
        ...subscription,
        unsubscribe: () => {
          activeCount--
          subscription.unsubscribe()
        },
      }
    },
  }
  const connection = createConnection(gated, () => undefined)
  connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.subscribe", params: {} }))
  await waitUntil(() => activeCount === 1, "the subscription to start opening")
  connection.close()
  release()
  await waitUntil(() => activeCount === 0, "the late subscription to be ended")
})

test("a subscription queued before the connection closed is never created", async () => {
  const controller = await openController(inventory)
  let activeCount = 0
  const counted: Controller = {
    request: controller.request.bind(controller),
    close: () => controller.close(),
    subscribe: async (listener, options) => {
      activeCount++
      const subscription = await controller.subscribe(listener, options)
      return {
        ...subscription,
        unsubscribe: () => {
          activeCount--
          subscription.unsubscribe()
        },
      }
    },
  }
  const connection = createConnection(counted, () => undefined)
  connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.subscribe", params: {} }))
  connection.close()
  await nextTurn()
  expect(activeCount).toBe(0)
})

test("a failure that does not match its error schema still settles", async () => {
  const Wrong = defineCapability({
    name: "Wrong",
    state: Schema.Struct({ n: Schema.Int }),
    actions: (action) => ({
      Go: action({
        error: Schema.Struct({ count: Schema.Int }),
        handler: () => Effect.sleep("1 millis").pipe(Effect.andThen(Effect.fail({ count: 1.5 }))),
      }),
    }),
  })
  const session = await pool.open(focused("wrong", Wrong, { n: 0 }))
  expect(await session.raw.dispatchRaw("Go")).toMatchObject({
    status: "failed",
    error: { defect: true },
  })
})

test("typed error data is scrubbed in results, events and replay", async () => {
  const Failure = Schema.Struct({ token: Schema.Redacted(Schema.String) })
  const Leaky = defineCapability({
    name: "Leaky",
    state: Schema.Struct({ n: Schema.Int }),
    actions: (action) => ({
      Go: action({
        error: Failure,
        handler: () => Effect.fail({ token: Redacted.make("hunter2") }),
      }),
    }),
  })
  const session = await pool.open(focused("leaky", Leaky, { n: 0 }))
  const result = await session.raw.dispatchRaw("Go")
  expect(result).toMatchObject({ error: { data: { token: "<redacted>" } } })
  expect(JSON.stringify(session.events)).not.toContain("hunter2")

  const replayed: Array<unknown> = []
  session.client.onEvent((event) => replayed.push(event))
  const { sessionId } = await session.client.request("app.describe", {})
  await session.client.request("app.subscribe", { since: { sessionId, sequence: 0 } })
  await waitUntil(
    () => JSON.stringify(replayed).includes("<redacted>"),
    "the failure is replayed, scrubbed",
  )
  expect(JSON.stringify(replayed)).not.toContain("hunter2")
})

const Blank = defineCapability({ name: "Blank", state: Schema.Struct({}), actions: () => ({}) })

test("route params are scrubbed before they reach navigation state", async () => {
  const Nav = defineNavigationFactories("test/Secret", {
    Home: Schema.Struct({}),
    Vault: Schema.Struct({ token: Schema.Redacted(Schema.String) }),
  })
  const Home = defineCapability({
    name: "Home",
    state: Schema.Struct({}),
    actions: (action) => ({
      Open: action({
        error: NavigationRefused,
        handler: () =>
          Effect.gen(function* () {
            const nav = yield* Nav.Tag
            yield* nav.push("Vault", { token: Redacted.make("hunter2") })
          }),
      }),
    }),
  })
  const host = createEffectHost({
    name: "secret",
    defaultScenario: "default",
    root: Nav.layer({
      initial: { route: "Home", params: {} },
      screens: { Home: () => mount(Home, {}), Vault: () => mount(Blank, {}) },
    }),
    scenarios: { default: { layer: Layer.empty } },
  })
  const session = await pool.open(host)
  await session.raw.dispatchRaw("Open")
  expect((await session.inspectRaw("Navigation")).state).toMatchObject({
    stack: [{ route: "Home" }, { route: "Vault", params: { token: "<redacted>" } }],
  })
  expect(JSON.stringify(session.events)).not.toContain("hunter2")
})

test("cancelling a navigation abandons it, and it never lands later", async () => {
  const Nav = defineNavigationFactories("test/Slow", { A: Schema.Struct({}), B: Schema.Struct({}) })
  const blank = (name: string) =>
    defineCapability({ name, state: Schema.Struct({}), actions: () => ({}) })
  const host = createEffectHost({
    name: "slow",
    defaultScenario: "default",
    root: Nav.layer({
      initial: { route: "A", params: {} },
      screens: {
        A: () => mount(blank("A"), {}),
        B: () => Effect.andThen(Effect.sleep("1 second"), mount(blank("B"), {})),
      },
    }),
    scenarios: { default: { layer: Layer.empty, virtualTime: true } },
  })
  const session = await pool.open(host)
  const operation = await session.raw.start("Navigate", { route: "B", params: {} })
  await session.client.request("app.cancel", { operationId: operation.operationId })
  await session.waitFor({ operationId: operation.operationId })
  await session.advanceTime(5_000)

  const { node, tree } = await session.client.request("app.inspect", { tree: true })
  expect(node?.name).toBe("A")
  expect(tree?.some((candidate) => candidate.name === "B")).toBe(false)
  expect((await session.inspectRaw("Navigation")).state).toMatchObject({ stack: [{ route: "A" }] })

  // The navigator still works afterwards.
  const next = await session.raw.start("Navigate", { route: "B", params: {} })
  await session.advanceTime(1_000)
  await session.waitFor({ operationId: next.operationId })
  await session.raw.precondition("B")
})

test("the route stack is capped", async () => {
  const session = await pool.open(inventory)
  const settings = { route: "Settings", params: {} }
  for (let depth = 1; depth < NAVIGATION_STACK_DEPTH_MAX; depth++) {
    await session.raw.dispatchRaw("Navigate", settings)
  }
  await expect(session.raw.dispatchRaw("Navigate", settings)).rejects.toMatchObject({
    code: ErrorCode.ActionUnavailable,
  })
})

test("a route whose params cannot be encoded leaves the stack as it was", async () => {
  const Nav = defineNavigationFactories("test/Encoding", {
    Home: Schema.Struct({}),
    Dated: Schema.Struct({ at: Schema.Int }),
  })
  const Home = defineCapability({
    name: "Home",
    state: Schema.Struct({}),
    actions: (action) => ({
      Open: action({
        error: NavigationRefused,
        handler: () =>
          Effect.gen(function* () {
            const nav = yield* Nav.Tag
            yield* nav.push("Dated", { at: 1.5 })
          }),
      }),
    }),
  })
  const host = createEffectHost({
    name: "encoding",
    defaultScenario: "default",
    root: Nav.layer({
      initial: { route: "Home", params: {} },
      screens: { Home: () => mount(Home, {}), Dated: () => mount(Blank, {}) },
    }),
    scenarios: { default: { layer: Layer.empty } },
  })
  const session = await pool.open(host)
  expect(await session.raw.dispatchRaw("Open")).toMatchObject({
    status: "failed",
    error: { defect: true },
  })
  const { tree } = await session.client.request("app.inspect", { tree: true })
  expect(tree?.some((node) => node.name === "Blank")).toBe(false)
  expect((await session.inspectRaw("Navigation")).state).toMatchObject({
    stack: [{ route: "Home" }],
  })
})

test("a cancelled save leaves its screen usable", async () => {
  const session = await pool.open(inventory, { scenario: "slow-network" })
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })
  const operation = await session.raw.start("Save")
  await session.waitFor({ match: { _tag: "saving" } })
  await session.client.request("app.cancel", { operationId: operation.operationId })
  await session.waitFor({ operationId: operation.operationId })

  expect(session.raw.state).toMatchObject({ _tag: "editing", error: null })
  await session.raw.dispatchRaw("Increment")
  expect(session.raw.state).toMatchObject({ quantity: 6 })
})

const reader = (lines: Array<string>, frameCharactersMax?: number) => {
  const overflows = { count: 0 }
  const read = createLineReader({
    onLine: (line) => lines.push(line),
    onOverflow: () => overflows.count++,
    ...(frameCharactersMax === undefined ? {} : { frameCharactersMax }),
  })
  return { read, overflows }
}

test("a multi-byte character split across chunks survives", () => {
  const lines: Array<string> = []
  const { read } = reader(lines)
  const bytes = new TextEncoder().encode('{"id":"café"}\n')
  const split = bytes.indexOf(0xc3) + 1
  read(bytes.slice(0, split))
  read(bytes.slice(split))
  expect(lines).toEqual(['{"id":"café"}'])
})

test("an unterminated frame is cut off, not buffered forever", () => {
  const { read, overflows } = reader([], 16)
  read("x".repeat(17))
  read("more")
  expect(overflows.count).toBe(1)
})

test("a failed test app cleans up after itself", async () => {
  const original = globalThis.fetch
  const { wrapped, stats } = counting(inventory)
  const stuck: AppHost = {
    ...wrapped,
    start: async (name, options) => {
      const session = await wrapped.start(name, options)
      session.runtime.track(toNodeId("none"), "forever", () => ({
        done: new Promise(() => undefined),
        cancel: () => undefined,
      }))
      return session
    },
  }
  await expect(createTestApp(stuck, { timeoutMs: 10 })).rejects.toMatchObject({
    code: ErrorCode.WaitTimeout,
  })
  expect(stats.live).toBe(0)
  expect(globalThis.fetch).toBe(original)
})

test("the network guard holds until the last test app is gone", async () => {
  const original = globalThis.fetch
  const first = await createTestApp(inventory)
  const second = await createTestApp(inventory)
  await first.dispose()
  await first.dispose()
  expect(() => fetch("https://example.com")).toThrow("Unexpected network request")
  await second.dispose()
  expect(globalThis.fetch).toBe(original)
})

test("a start that never finishes cannot hold up close", async () => {
  let hang = false
  let finishStart = () => {}
  const late: Array<AppSession> = []
  const lateDisposals: Array<string> = []
  const host: AppHost = {
    ...inventory,
    start: async (name, options) => {
      if (hang) {
        await new Promise<void>((resolve) => {
          finishStart = resolve
        })
      }
      const session = await inventory.start(name, options)
      if (!hang) {
        return session
      }
      late.push(session)
      return {
        ...session,
        dispose: async () => {
          lateDisposals.push(session.runtime.sessionId)
          await session.dispose()
        },
      }
    },
  }
  const controller = await openController(host)
  hang = true
  const reset = controller.request("app.reset", {}).catch((error: unknown) => error)
  await nextTurn()
  await controller.close()
  expect(await reset).toMatchObject({ code: ErrorCode.SessionClosed })

  // If the start does finish afterwards, its session is ended, not left running.
  finishStart()
  await waitUntil(() => lateDisposals.length === 1, "the late session is disposed")
  const [session] = late
  await waitUntil(() => session !== undefined, "the late session exists")
  const waiting = session?.runtime.wait({ focus: "Never", timeoutMs: 60_000 })
  await expect(waiting).rejects.toMatchObject({ code: ErrorCode.SessionClosed })
})

test("a late session that fails to dispose is reported, not left unhandled", async () => {
  let hang = false
  let finishStart = () => {}
  const reported: Array<unknown> = []
  const host: AppHost = {
    ...inventory,
    start: async (name, options) => {
      const session = await inventory.start(name, options)
      if (!hang) {
        return session
      }
      await new Promise<void>((resolve) => {
        finishStart = resolve
      })
      return { ...session, dispose: () => Promise.reject(new Error("bad dispose")) }
    },
  }
  const controller = await openController(host, {
    onBackgroundError: (error) => reported.push(error),
  })
  hang = true
  const reset = controller.request("app.reset", {}).catch((error: unknown) => error)
  await waitUntil(() => finishStart.name !== "finishStart", "the reset reached the new start")
  await controller.close()
  await reset
  finishStart()
  await waitUntil(() => reported.length === 1, "the failure is reported")
})

test("queued resets are capped", async () => {
  const controller = await openController(inventory)
  const resets = Array.from({ length: 12 }, () =>
    controller.request("app.reset", {}).catch((error: unknown) => error),
  )
  const outcomes = await Promise.all(resets)
  const refused = outcomes.filter(
    (outcome) => outcome instanceof ProtocolError && outcome.code === ErrorCode.ResourceExhausted,
  )
  expect(refused).toHaveLength(4)
})

test("a start that times out leaves the controller recoverable", async () => {
  let hang = false
  const { timers, expire } = manualTimers()
  const host: AppHost = {
    ...inventory,
    start: (name, options) =>
      hang ? new Promise(() => undefined) : inventory.start(name, options),
  }
  const controller = await openController(host, { timers })
  hang = true
  const reset = controller.request("app.reset", {}).catch((error: unknown) => error)
  await nextTurn()
  expire()
  expect(await reset).toMatchObject({ message: expect.stringContaining("did not start") })
  hang = false
  await controller.request("app.reset", {})
  await controller.request("app.wait", { focus: "InventoryList" })
})

test("a first start that never finishes fails instead of hanging", async () => {
  const { timers, expire } = manualTimers()
  const host: AppHost = { ...inventory, start: () => new Promise(() => undefined) }
  const starting = createController(host, { timers }).catch((error: unknown) => error)
  await nextTurn()
  expire()
  expect(await starting).toMatchObject({ message: expect.stringContaining("did not start") })
})

test("a dispose that never finishes cannot hold up close", async () => {
  const { timers, expire } = manualTimers()
  const host: AppHost = {
    ...inventory,
    start: async (name, options) => ({
      ...(await inventory.start(name, options)),
      dispose: () => new Promise(() => undefined),
    }),
  }
  const controller = await createController(host, { timers })
  const closing = controller.close().catch((error: unknown) => error)
  await nextTurn()
  expire()
  expect(await closing).toMatchObject({ message: expect.stringContaining("did not dispose") })
})

test("a start that outlives its deadline is ended when it finally arrives", async () => {
  const { timers, expire } = manualTimers()
  const late = await inventory.start("inventory-with-products", { sessionId: "late" })
  let disposeCount = 0
  let finish = (_: AppSession) => {}
  const starting = new Promise<AppSession>((resolve) => {
    finish = resolve
  })
  const waiting = awaitSession(starting, {
    timers,
    onBackgroundError: () => undefined,
  }).catch((error: unknown) => error)
  expire()
  expect(await waiting).toMatchObject({ code: ErrorCode.SessionClosed })
  finish({
    ...late,
    dispose: async () => {
      disposeCount++
      await late.dispose()
    },
  })
  await waitUntil(() => disposeCount === 1, "the late session is disposed")
  expect(late.runtime.closed).toBe(true)
})

test("a late start that fails is reported, as nobody is waiting for it", async () => {
  const { timers, expire } = manualTimers()
  const reported: Array<unknown> = []
  let fail = (_: Error) => {}
  const starting = new Promise<AppSession>((_, reject) => {
    fail = reject
  })
  const waiting = awaitSession(starting, {
    timers,
    onBackgroundError: (error) => reported.push(error),
  }).catch((error: unknown) => error)
  expire()
  await waiting
  fail(new Error("too late"))
  await waitUntil(() => reported.length === 1, "the failure is reported")
})

test("subscribing during a reset waits for it", async () => {
  let gate = Promise.resolve()
  const host: AppHost = {
    ...inventory,
    start: async (name, options) => {
      await gate
      return inventory.start(name, options)
    },
  }
  const controller = await openController(host)
  let open = () => {}
  gate = new Promise((resolve) => {
    open = resolve
  })
  const lines: Array<unknown> = []
  const connection = createConnection(controller, (line) => lines.push(JSON.parse(line)))
  const reset = controller.request("app.reset", {})
  await nextTurn()
  connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.subscribe" }))
  await nextTurn()
  open()
  await reset
  await waitUntil(() => lines.length > 0, "the subscription is answered")
  expect(lines[0]).toMatchObject({ id: 1, result: { sessionId: "session-2" } })
  connection.close()
})

test("a disposal that throws still ends the runtime's waits", async () => {
  const host: AppHost = {
    ...inventory,
    start: async (name, options) => {
      const session = await inventory.start(name, options)
      const dispose = async () => {
        await session.dispose()
        throw new Error("bad dispose")
      }
      return { ...session, dispose }
    },
  }
  const controller = await openController(host)
  // Not `expect(...).rejects` yet: Bun's blocks until the promise settles.
  const waiting = controller
    .request("app.wait", { focus: "Never", timeoutMs: 60_000 })
    .catch((error: unknown) => error)
  await nextTurn()
  await expect(controller.request("app.reset", {})).rejects.toThrow("bad dispose")
  expect(await waiting).toMatchObject({ code: ErrorCode.SessionClosed })
  await controller.close()
})

test("a complete frame over the limit is refused too", () => {
  const lines: Array<string> = []
  const whole = reader(lines, 16)
  whole.read(`${"x".repeat(17)}\n`)
  expect(whole.overflows.count).toBe(1)

  const split = reader(lines, 16)
  split.read("x".repeat(10))
  split.read(`${"x".repeat(10)}\n`)
  expect(split.overflows.count).toBe(1)
  expect(lines).toEqual([])
})

test("a screen that fails to build leaves nothing behind", async () => {
  const Nav = defineNavigationFactories("test/Defect", {
    A: Schema.Struct({}),
    B: Schema.Struct({}),
  })
  let released = 0
  const Partial = defineCapability({
    name: "Partial",
    state: Schema.Struct({}),
    actions: () => ({}),
  })
  const host = createEffectHost({
    name: "defect",
    defaultScenario: "default",
    root: Nav.layer({
      initial: { route: "A", params: {} },
      screens: {
        A: () =>
          mount(defineCapability({ name: "A", state: Schema.Struct({}), actions: () => ({}) }), {}),
        B: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => released++))
            yield* mount(Partial, {})
            return yield* Effect.die(new Error("factory failed"))
          }),
      },
    }),
    scenarios: { default: { layer: Layer.empty } },
  })
  const session = await pool.open(host)
  const result = await session.raw.dispatchRaw("Navigate", { route: "B", params: {} })
  expect(result.status).toBe("failed")
  expect(released).toBe(1)
  const { tree } = await session.client.request("app.inspect", { tree: true })
  expect(tree?.some((node) => node.name === "Partial")).toBe(false)
})

test("a wait from a connection that has already gone never starts", async () => {
  const controller = await openController(inventory)
  const lifetime = new AbortController()
  lifetime.abort()
  const waiting = controller.request(
    "app.wait",
    { focus: "Never", timeoutMs: 60_000 },
    { signal: lifetime.signal },
  )
  await expect(waiting).rejects.toMatchObject({ code: ErrorCode.SessionClosed })
})

test("starts that outlive their timeout are capped", async () => {
  let hang = false
  const host: AppHost = {
    ...inventory,
    start: (name, options) =>
      hang ? new Promise(() => undefined) : inventory.start(name, options),
  }
  const { timers, expire } = manualTimers()
  const controller = await openController(host, { timers })
  hang = true
  const codes: Array<unknown> = []
  for (let attempt = 0; attempt < 5; attempt++) {
    const reset = controller.request("app.reset", {}).catch((error: unknown) => error)
    await nextTurn()
    expire()
    const failure = await reset
    codes.push(failure instanceof ProtocolError ? failure.code : undefined)
  }
  expect(codes.at(-2)).toBe(ErrorCode.SessionClosed)
  expect(codes.at(-1)).toBe(ErrorCode.ResourceExhausted)
})

test("a start that fails is reported once, to whoever asked", async () => {
  let fail = false
  const reported: Array<unknown> = []
  const host: AppHost = {
    ...inventory,
    start: (name, options) =>
      fail ? Promise.reject(new Error("no")) : inventory.start(name, options),
  }
  const controller = await openController(host, {
    onBackgroundError: (error) => reported.push(error),
  })
  fail = true
  await expect(controller.request("app.reset", {})).rejects.toThrow("no")
  await nextTurn()
  expect(reported).toEqual([])
})

test("an operation id from before a reset finds nothing after it", async () => {
  const controller = await openController(inventory)
  await controller.request("app.wait", { idle: true })
  const operation = await controller.request("app.dispatch", { action: "OpenSettings" })
  await controller.request("app.reset", {})
  await expect(
    controller.request("app.cancel", { operationId: operation.operationId }),
  ).rejects.toMatchObject({ code: ErrorCode.OperationNotFound })
})

test("a subscriber that fails while a reset replays leaves the new session running", async () => {
  const { wrapped, stats } = counting(inventory)
  const controller = await openController(wrapped)
  await controller.subscribe(() => {
    throw new Error("subscriber failed")
  })
  await controller.request("app.reset", {})
  await controller.request("app.wait", { focus: "InventoryList" })
  await controller.close()
  expect(stats.live).toBe(0)
})

test("a wait naming a node needs that node to exist", async () => {
  const session = await pool.open(inventory)
  await expect(
    session.client.request("app.wait", { name: "Nothing", timeoutMs: 1 }),
  ).rejects.toMatchObject({ code: ErrorCode.WaitTimeout })
  await session.client.request("app.wait", { name: "Navigation" })
})

test("a wait's match is limited in size, as waits are held for a long time", async () => {
  const session = await pool.open(inventory)
  const match = "x".repeat(WAIT_MATCH_CHARACTERS_MAX)
  await expect(session.client.request("app.wait", { match })).rejects.toMatchObject({
    code: ErrorCode.InvalidParams,
  })
})

test("coming back to a screen keeps its edits and its running save", async () => {
  const session = await pool.open(inventory, { scenario: "sluggish-network" })
  await session.raw.dispatchRaw("OpenProduct", { productId: "product-123" })
  await session.raw.dispatchRaw("SetQuantity", { quantity: 12 })
  await session.raw.dispatchRaw("Navigate", { route: "Settings", params: {} })
  await session.raw.dispatchRaw("GoBack")
  expect(session.raw.state).toMatchObject({ _tag: "editing", quantity: 12 })

  await session.raw.start("Save")
  await session.waitFor({ match: { _tag: "saving" } })
  await session.client.request("app.dispatch", {
    action: "Navigate",
    input: { route: "Settings", params: {} },
    await: true,
  })
  await session.client.request("app.dispatch", { action: "GoBack", await: true })
  await session.inspect()
  expect(session.raw.state).toMatchObject({ _tag: "saving" })
})

const screenThatRedirects = () => {
  const Nav = defineNavigationFactories("test/Redirect", { Home: NoParams, Next: NoParams })
  const Plain = defineCapability({ name: "Plain", state: Schema.Struct({}), actions: () => ({}) })
  const redirecting = Effect.gen(function* () {
    const nav = yield* Nav.Tag
    yield* nav.push("Next", {})
    return yield* mount(Plain, {})
  })
  return createEffectHost({
    name: "redirect",
    defaultScenario: "default",
    root: Nav.layer({
      initial: { route: "Home", params: {} },
      screens: {
        Home: () => mount(Plain, {}),
        Next: () => redirecting.pipe(Effect.orDie),
      },
    }),
    scenarios: { default: { layer: Layer.empty } },
  })
}

test("a screen that navigates while being built fails, instead of waiting on itself", async () => {
  const session = await pool.open(screenThatRedirects())
  const result = await session.raw.dispatchRaw("Navigate", { route: "Next", params: {} })
  expect(result).toMatchObject({
    status: "failed",
    error: { message: expect.stringContaining("while being built") },
  })
  expect((await session.inspectRaw("Navigation")).state).toMatchObject({
    stack: [{ route: "Home" }],
  })
})

test("control requests past their deadline stay counted until they end", async () => {
  const { timers, expire } = manualTimers()
  const reported: Array<unknown> = []
  const pending: Array<(error: Error) => void> = []
  const host: AppHost = {
    ...inventory,
    start: async (name, options) => {
      const session = await inventory.start(name, options)
      return {
        ...session,
        advanceTime: () =>
          new Promise((_, reject) => {
            pending.push(reject)
          }),
      }
    },
  }
  const controller = await openController(host, {
    timers,
    onBackgroundError: (error) => reported.push(error),
  })
  for (let index = 0; index < OUTSTANDING_CONTROL_REQUESTS_MAX; index++) {
    const request = controller
      .request("app.advanceTime", { durationMs: 1 })
      .catch((error: unknown) => error)
    await nextTurn()
    expire()
    expect(await request).toMatchObject({ code: ErrorCode.WaitTimeout })
  }
  await expect(controller.request("app.advanceTime", { durationMs: 1 })).rejects.toMatchObject({
    code: ErrorCode.ResourceExhausted,
  })
  pending[0]?.(new Error("failed late"))
  await waitUntil(() => reported.length === 1, "the late failure is reported")
})

test("a control request refused by a failed reset gives its slot back", async () => {
  let fail = false
  const host: AppHost = {
    ...inventory,
    start: (name, options) =>
      fail ? Promise.reject(new Error("no")) : inventory.start(name, options),
  }
  const controller = await openController(host)
  fail = true
  await expect(controller.request("app.reset", {})).rejects.toThrow("no")
  for (let index = 0; index < OUTSTANDING_CONTROL_REQUESTS_MAX + 1; index++) {
    await expect(controller.request("app.sample", { action: "Refresh" })).rejects.toMatchObject({
      code: ErrorCode.SessionClosed,
    })
  }
  fail = false
  await controller.request("app.reset", {})
  await controller.request("app.wait", { focus: "InventoryList", idle: true })
  await controller.request("app.sample", { action: "OpenProduct" })
})

test("an abandoned start whose disposal fails still frees its slot", async () => {
  const { timers, expire } = manualTimers()
  const reported: Array<unknown> = []
  let lateStarts: Array<(session: AppSession) => void> = []
  let hang = false
  const host: AppHost = {
    ...inventory,
    start: (name, options) => {
      if (!hang) {
        return inventory.start(name, options)
      }
      return new Promise((resolve) => {
        lateStarts.push(resolve)
      })
    },
  }
  const controller = await openController(host, {
    timers,
    onBackgroundError: (error) => reported.push(error),
  })
  hang = true
  for (let index = 0; index < 4; index++) {
    const reset = controller.request("app.reset", {}).catch((error: unknown) => error)
    await nextTurn()
    expire()
    await reset
  }
  const late = await inventory.start("inventory-with-products", { sessionId: "late" })
  for (const finish of lateStarts) {
    finish({ ...late, dispose: () => Promise.reject(new Error("bad dispose")) })
  }
  lateStarts = []
  await waitUntil(() => reported.length === 4, "each late failure is reported")
  await nextTurn()
  hang = false
  await controller.request("app.reset", {})
  await late.dispose()
})

test("a pool disposes everything even if one app fails to", async () => {
  const original = globalThis.fetch
  const failing = createTestAppPool()
  const host: AppHost = {
    ...inventory,
    start: async (name, options) => ({
      ...(await inventory.start(name, options)),
      dispose: () => Promise.reject(new Error("bad dispose")),
    }),
  }
  await failing.open(host)
  await failing.open(inventory)
  await expect(failing.disposeAll()).rejects.toThrow("failed to dispose")
  expect(globalThis.fetch).toBe(original)
})

test("disposals that outlive their deadline hold their slots until they end", async () => {
  const { timers, expire } = manualTimers()
  const unfinished: Array<() => void> = []
  const host: AppHost = {
    ...inventory,
    start: async (name, options) => {
      const session = await inventory.start(name, options)
      return {
        ...session,
        dispose: () =>
          new Promise<void>((resolve) => {
            unfinished.push(resolve)
          }).then(() => session.dispose()),
      }
    },
  }
  const controller = await openController(host, { timers })
  const reset = async () => {
    const pending = controller.request("app.reset", {}).catch((error: unknown) => error)
    await nextTurn()
    expire()
    return pending
  }
  // Each round trip times out disposing, then recovers with a fresh session.
  for (let index = 0; index < UNFINISHED_SESSIONS_MAX - 1; index++) {
    expect(await reset()).toBeInstanceOf(Error)
    await controller.request("app.reset", {})
  }
  expect(await reset()).toBeInstanceOf(Error)
  await expect(controller.request("app.reset", {})).rejects.toMatchObject({
    code: ErrorCode.ResourceExhausted,
  })
  unfinished.shift()?.()
  await waitUntil(() => unfinished.length === UNFINISHED_SESSIONS_MAX - 1, "a disposal to end")
  await nextTurn()
  await controller.request("app.reset", {})
  const closing = controller.close()
  await nextTurn()
  for (const finish of unfinished.splice(0)) {
    finish()
  }
  await closing
})

/** A peer's view of a connection whose controller is driven by the test. */
const heldConnection = (encodeEvent?: (event: RuntimeEvent) => string | null) => {
  const lines: Array<string> = []
  let emit: (event: RuntimeEvent) => void = () => undefined
  let finishWait: () => void = () => undefined
  const controller: Controller = {
    request: async (method) => {
      if (method === "app.wait") {
        await new Promise<void>((resolve) => {
          finishWait = resolve
        })
      }
      return { ok: true } as never
    },
    subscribe: async (listener) => {
      emit = listener
      return { unsubscribe: () => undefined, sessionId: "s", sequence: 0 }
    },
    close: async () => undefined,
  }
  const connection = createConnection(
    controller,
    (line) => lines.push(line),
    encodeEvent === undefined ? {} : { encodeEvent },
  )
  const request = (id: number, method: string) => ({ jsonrpc: "2.0", id, method, params: {} })
  connection.receive(JSON.stringify([request(1, "app.subscribe"), request(2, "app.wait")]))
  return {
    lines,
    connection,
    request,
    emit: (event: RuntimeEvent) => emit(event),
    finishWait: () => finishWait(),
    notifications: () => lines.filter((line) => line.includes(EVENT_NOTIFICATION)),
  }
}

const startedEvent = (sequence: number): RuntimeEvent => ({
  type: "operation.started",
  sessionId: "s",
  sequence,
  revision: sequence,
  operation: {
    operationId: toOperationId("o"),
    nodeId: toNodeId("n"),
    action: "A",
    status: "running",
  },
})

test("another reply does not release events held for a batch's reply", async () => {
  const peer = heldConnection()
  await nextTurn()
  peer.emit(startedEvent(1))
  peer.connection.receive(JSON.stringify(peer.request(3, "app.describe")))
  await nextTurn()
  expect(peer.lines).toHaveLength(1)
  expect(peer.notifications()).toEqual([])
  peer.finishWait()
  await nextTurn()
  expect(peer.lines).toHaveLength(3)
  expect(peer.lines[1]?.startsWith("[")).toBe(true)
  expect(peer.lines[2]).toContain("operation.started")
})

test("as many events as the log keeps are held for a reply, in full", async () => {
  const peer = heldConnection()
  await nextTurn()
  for (let sequence = 1; sequence <= RETAINED_EVENTS_MAX; sequence++) {
    peer.emit(startedEvent(sequence))
  }
  peer.finishWait()
  await nextTurn()
  expect(peer.notifications()).toHaveLength(RETAINED_EVENTS_MAX)
})

test("past that, a held subscription is told to resynchronize", async () => {
  const peer = heldConnection()
  await nextTurn()
  const count = RETAINED_EVENTS_MAX + 5
  for (let sequence = 1; sequence <= count; sequence++) {
    peer.emit(startedEvent(sequence))
  }
  peer.finishWait()
  await nextTurn()
  const [only, ...rest] = peer.notifications()
  expect(rest).toEqual([])
  expect(only).toContain("resync.required")
  expect(only).toContain(`"sequence":${count}`)
  peer.emit(startedEvent(count + 1))
  expect(peer.notifications()[1]).toContain("operation.started")
})

test("what is held for one reply is available again to the next", async () => {
  const large = "x".repeat(1024 * 1024)
  const peer = heldConnection((event) =>
    event.type === "resync.required" ? JSON.stringify(event) : large,
  )
  await nextTurn()
  const count = Math.floor(HELD_EVENT_CHARACTERS_MAX / large.length)
  const fill = () => {
    for (let sequence = 1; sequence <= count; sequence++) {
      peer.emit(startedEvent(sequence))
    }
    peer.finishWait()
  }
  fill()
  await nextTurn()
  peer.connection.receive(
    JSON.stringify([peer.request(4, "app.subscribe"), peer.request(5, "app.wait")]),
  )
  await nextTurn()
  fill()
  await nextTurn()
  expect(peer.notifications().filter((line) => line.includes("resync.required"))).toEqual([])
  expect(peer.notifications().length).toBeGreaterThanOrEqual(count * 2)
})

test("events that cannot be sent still count towards what is held", async () => {
  const peer = heldConnection(() => null)
  await nextTurn()
  const count = Math.floor(HELD_EVENT_CHARACTERS_MAX / FRAME_CHARACTERS_MAX) + 1
  for (let sequence = 1; sequence <= count; sequence++) {
    peer.emit(startedEvent(sequence))
  }
  peer.finishWait()
  await nextTurn()
  expect(peer.notifications()).toHaveLength(1)
})

test("nothing held is sent for a subscription that has gone", async () => {
  const peer = heldConnection()
  await nextTurn()
  peer.emit(startedEvent(1))
  const unsubscribe = { ...peer.request(3, "app.unsubscribe"), params: { subscriptionId: "sub-1" } }
  peer.connection.receive(JSON.stringify(unsubscribe))
  await nextTurn()
  peer.finishWait()
  await nextTurn()
  expect(peer.notifications()).toEqual([])
})

test("a reply far over the limit is refused without being rendered", async () => {
  const shared = "x".repeat(1024 * 1024)
  const tree = Array.from({ length: 128 }, () => ({ state: shared }))
  const controller: Controller = {
    request: async () => ({ tree }) as never,
    subscribe: async () => ({ unsubscribe: () => undefined, sessionId: "s", sequence: 0 }),
    close: async () => undefined,
  }
  const lines: Array<string> = []
  const connection = createConnection(controller, (line) => lines.push(line))
  const render = spyOn(JSON, "stringify")
  try {
    connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.inspect", params: {} }))
    await waitUntil(() => lines.length > 0, "the request is answered")
    const rendered = render.mock.results.map(({ value }) => String(value).length)
    expect(Math.max(...rendered)).toBeLessThan(FRAME_CHARACTERS_MAX)
  } finally {
    render.mockRestore()
  }
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({
    id: 1,
    error: { code: ErrorCode.ResourceExhausted },
  })
})

test("a reply that is not JSON says so, and is reported as the app's mistake", async () => {
  const controller: Controller = {
    request: async () => ({ error: undefined, n: 0 }) as never,
    subscribe: async () => ({ unsubscribe: () => undefined, sessionId: "s", sequence: 0 }),
    close: async () => undefined,
  }
  const lines: Array<string> = []
  const reported: Array<unknown> = []
  const connection = createConnection(controller, (line) => lines.push(line), {
    onBackgroundError: (error) => reported.push(error),
  })
  connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.inspect", params: {} }))
  await waitUntil(() => lines.length > 0, "the request is answered")
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({
    id: 1,
    error: { code: ErrorCode.InternalError, message: "The reply is not JSON" },
  })
  expect(reported).toHaveLength(1)
})

test("an event that is not JSON is reported, and the peer told to resynchronize", async () => {
  const reported: Array<unknown> = []
  let emit: (event: RuntimeEvent) => void = () => undefined
  const controller: Controller = {
    request: async () => ({}) as never,
    subscribe: async (listener) => {
      emit = listener
      return { unsubscribe: () => undefined, sessionId: "s", sequence: 0 }
    },
    close: async () => undefined,
  }
  const lines: Array<string> = []
  const connection = createConnection(controller, (line) => lines.push(line), {
    onBackgroundError: (error) => reported.push(error),
  })
  connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.subscribe", params: {} }))
  await waitUntil(() => lines.length > 0, "the subscription is open")
  const state = { error: undefined } as never
  emit({ ...startedEvent(1), type: "state.changed", nodeId: toNodeId("n"), state } as RuntimeEvent)
  expect(lines[1]).toContain("resync.required")
  expect(reported).toHaveLength(1)
})

test("a reply that only renders too large is still refused", async () => {
  // Under the limit as text, over it once every character is escaped.
  const text = '"'.repeat(FRAME_CHARACTERS_MAX * 0.75)
  const controller: Controller = {
    request: async () => ({ text }) as never,
    subscribe: async () => ({ unsubscribe: () => undefined, sessionId: "s", sequence: 0 }),
    close: async () => undefined,
  }
  const lines: Array<string> = []
  const connection = createConnection(controller, (line) => lines.push(line))
  connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.inspect", params: {} }))
  await waitUntil(() => lines.length > 0, "the request is answered")
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({
    error: { code: ErrorCode.ResourceExhausted },
  })
})

test("events held for a reply are limited by size, not only by count", async () => {
  const large = "x".repeat(1024 * 1024)
  const peer = heldConnection((event) =>
    event.type === "resync.required" ? JSON.stringify(event) : large,
  )
  await nextTurn()
  const count = Math.floor(HELD_EVENT_CHARACTERS_MAX / large.length) + 1
  for (let sequence = 1; sequence <= count; sequence++) {
    peer.emit(startedEvent(sequence))
  }
  peer.finishWait()
  await nextTurn()
  expect(peer.notifications()).toHaveLength(1)
  expect(peer.notifications()[0]).toContain("resync.required")
})

/** Two screens, and whatever the second has to do on its way out. */
const stackApp = (options: {
  readonly values?: ReadonlyArray<number>
  readonly text?: string
  readonly finalizer?: Effect.Effect<void>
  /** Fail building the screen, once its cleanup is in place. */
  readonly failBuild?: boolean
  readonly stayWork?: Effect.Effect<void>
  readonly screenText?: string
  /** A resource the screen acquires as it is built, which cannot be interrupted. */
  readonly acquire?: Effect.Effect<void>
  readonly onRelease?: () => void
}) => {
  const Nav = defineNavigationFactories("test/Stack", {
    Home: NoParams,
    Next: Schema.Struct({ values: Schema.Array(Schema.Int), text: Schema.String }),
  })
  const refusals: Array<string> = []
  const refused = ({ message }: { readonly message: string }) =>
    Effect.sync(() => {
      refusals.push(message)
    })
  const open = Effect.gen(function* () {
    const nav = yield* Nav.Tag
    yield* nav.push("Next", { values: options.values ?? [], text: options.text ?? "" })
  }).pipe(
    Effect.catchTag("NavigationStackFull", refused),
    Effect.catchTag("ScreenBuildTimedOut", refused),
  )
  const Home = defineCapability({
    name: "Home",
    state: Schema.Struct({}),
    actions: (action) => ({
      Open: action({
        error: NavigationRefused,
        handler: () => open,
      }),
      Ping: action({ handler: () => Effect.void }),
    }),
  })
  const Next = defineCapability({
    name: "Next",
    state: Schema.Struct({ text: Schema.String }),
    actions: (action) => ({
      Open: action({
        error: NavigationRefused,
        handler: () => open,
      }),
      Stay: action({ handler: () => options.stayWork ?? Effect.void }),
    }),
  })
  const mountNext = Effect.gen(function* () {
    const { acquire, onRelease } = options
    if (acquire !== undefined) {
      yield* Effect.acquireRelease(acquire, () => Effect.sync(() => onRelease?.()))
    }
    const node = yield* mount(Next, { text: options.screenText ?? "" })
    yield* Effect.addFinalizer(() => options.finalizer ?? Effect.void)
    if (options.failBuild === true) {
      return yield* Effect.die(new Error("no screen today"))
    }
    return node
  })
  const host = createEffectHost({
    name: "stack",
    defaultScenario: "default",
    root: Nav.layer({
      initial: { route: "Home", params: {} },
      screens: { Home: () => mount(Home, {}), Next: () => mountNext },
    }),
    scenarios: { default: { layer: Layer.empty, virtualTime: true } },
  })
  return { host, refusals }
}

test("a push too large for state changes nothing, and is refused as expected", async () => {
  const text = "x".repeat(NODE_STATE_CHARACTERS_MAX * 0.6)
  const { host, refusals } = stackApp({ text })
  const session = await pool.open(host)
  const inspect = () => session.client.request("app.inspect", { tree: true })
  expect((await session.raw.dispatchRaw("Open")).status).toBe("completed")
  const before = await inspect()
  expect((await session.raw.dispatchRaw("Open")).status).toBe("completed")
  expect(refusals).toHaveLength(1)
  const after = await inspect()
  expect(after.focus).toEqual(before.focus)
  expect(JSON.stringify(after.tree)).toEqual(JSON.stringify(before.tree))

  // What is on the stack and what was published must still agree.
  expect((await session.raw.dispatchRaw("GoBack")).status).toBe("completed")
  expect((await inspect()).node?.name).toBe("Home")
})

test("params too large for state are refused, not a crash, from a single push", async () => {
  const { host, refusals } = stackApp({ text: "x".repeat(NODE_STATE_CHARACTERS_MAX + 1) })
  const session = await pool.open(host)
  expect((await session.raw.dispatchRaw("Open")).status).toBe("completed")
  expect(refusals).toHaveLength(1)
  expect((await session.client.request("app.inspect", {})).node?.name).toBe("Home")
})

test("a stack's state is limited in total, however valid each push", async () => {
  const { host, refusals } = stackApp({ text: "x".repeat(NODE_STATE_CHARACTERS_MAX / 4) })
  const session = await pool.open(host)
  for (let index = 0; index < 5; index++) {
    await session.raw.dispatchRaw("Open")
  }
  expect(refusals.length).toBeGreaterThan(0)
})

test("a screen's cleanup that fails cannot cost the app its focus", async () => {
  const report = spyOn(console, "error").mockImplementation(() => undefined)
  const { host } = stackApp({ finalizer: Effect.die(new Error("bad finalizer")) })
  const session = await pool.open(host)
  await session.raw.dispatchRaw("Open")
  expect(await session.raw.dispatchRaw("GoBack")).toMatchObject({
    status: "failed",
    error: { defect: true },
  })
  // Its operation says so, so it is not a background failure as well.
  expect(JSON.stringify(report.mock.calls)).not.toContain("bad finalizer")
  report.mockRestore()
  expect((await session.client.request("app.inspect", {})).node?.name).toBe("Home")
  expect((await session.raw.dispatchRaw("Ping")).status).toBe("completed")
})

test("a screen is out of reach as soon as it is left, however long its cleanup", async () => {
  let finishCleanup = () => {}
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve
  })
  const { host } = stackApp({ finalizer: Effect.promise(() => cleanup) })
  const session = await pool.open(host)
  await session.raw.dispatchRaw("Open")
  const { client } = session
  const { focus } = await client.request("app.inspect", {})
  const nodeId = defined(focus ?? undefined, "a screen has focus")
  const leaving = session.raw.dispatchRaw("GoBack")
  await waitUntil(() => session.events.some(({ type }) => type === "node.removed"), "the node goes")
  expect((await client.request("app.inspect", {})).node?.name).toBe("Home")
  await expect(client.request("app.dispatch", { action: "Stay", nodeId })).rejects.toMatchObject({
    code: ErrorCode.NodeNotFound,
  })
  finishCleanup()
  expect((await leaving).status).toBe("completed")
})

/** A cleanup the test finishes, or fails, when it wants to. */
const heldCleanup = () => {
  const finishers: Array<(outcome: Effect.Effect<void>) => void> = []
  let released = false
  return {
    finalizer: Effect.suspend(() =>
      released
        ? Effect.void
        : Effect.flatten(
            Effect.promise(
              () => new Promise<Effect.Effect<void>>((resolve) => finishers.push(resolve)),
            ),
          ),
    ),
    /** Later cleanups, such as at the end of the session, go straight through. */
    finish: (outcome: Effect.Effect<void> = Effect.void) => {
      released = true
      for (const finisher of finishers.splice(0)) {
        finisher(outcome)
      }
    },
    heldCount: () => finishers.length,
  }
}

test("a screen's cleanup cannot hold navigation forever", async () => {
  const held = heldCleanup()
  const report = spyOn(console, "error").mockImplementation(() => undefined)
  const { host } = stackApp({ finalizer: held.finalizer })
  const session = await pool.open(host)
  await session.raw.dispatchRaw("Open")
  const { operationId } = await session.client.request("app.dispatch", { action: "GoBack" })
  await waitUntil(() => held.heldCount() === 1, "the cleanup to start")
  await session.advanceTime(10_000)
  const { operation } = await session.client.request("app.wait", { operationId })
  expect(operation?.status).toBe("completed")
  expect(JSON.stringify(report.mock.calls)).toContain("too long to clean up")
  expect((await session.raw.dispatchRaw("Open")).status).toBe("completed")
  held.finish()
  report.mockRestore()
})

test("a build stuck acquiring cannot hold navigation, and leaves nothing when it ends", async () => {
  const held = heldCleanup()
  const spied = spyOn(console, "error").mockImplementation(() => undefined)
  let released = false
  const { host } = stackApp({
    acquire: held.finalizer,
    onRelease: () => {
      released = true
    },
  })
  const session = await pool.open(host)
  const { operationId } = await session.client.request("app.dispatch", { action: "Open" })
  await waitUntil(() => held.heldCount() === 1, "the build to start")
  await session.advanceTime(30_000)
  const { operation } = await session.client.request("app.wait", { operationId })
  expect(operation?.status).toBe("completed")
  expect((await session.raw.dispatchRaw("Ping")).status).toBe("completed")

  held.finish()
  await waitUntil(() => released, "what it acquired to be released")
  await nextTurn()
  const { tree } = await session.client.request("app.inspect", { tree: true })
  expect(tree?.filter(({ name }) => name === "Next")).toEqual([])
  spied.mockRestore()
})

test("a build that fails past its deadline is still reported", async () => {
  const held = heldCleanup()
  const report = spyOn(console, "error").mockImplementation(() => undefined)
  const { host } = stackApp({ acquire: held.finalizer })
  const session = await pool.open(host)
  const { operationId } = await session.client.request("app.dispatch", { action: "Open" })
  await waitUntil(() => held.heldCount() === 1, "the build to start")
  await session.advanceTime(30_000)
  await session.client.request("app.wait", { operationId })
  held.finish(Effect.die(new Error("late build failure")))
  await waitUntil(
    () => JSON.stringify(report.mock.calls).includes("late build failure"),
    "the late failure is reported",
  )
  report.mockRestore()
})

test("a build that fails after being cancelled is still reported", async () => {
  const held = heldCleanup()
  const report = spyOn(console, "error").mockImplementation(() => undefined)
  const { host } = stackApp({ acquire: held.finalizer })
  const session = await pool.open(host)
  const { operationId } = await session.client.request("app.dispatch", { action: "Open" })
  await waitUntil(() => held.heldCount() === 1, "the build to start")
  await session.client.request("app.cancel", { operationId })
  await session.client.request("app.wait", { operationId })
  held.finish(Effect.die(new Error("late build failure")))
  await waitUntil(
    () => JSON.stringify(report.mock.calls).includes("late build failure"),
    "the late failure is reported",
  )
  report.mockRestore()
})

test("a slow screen is a refusal a handler can catch, not a crash", async () => {
  const held = heldCleanup()
  const { host, refusals } = stackApp({ acquire: held.finalizer })
  const session = await pool.open(host)
  const { operationId } = await session.client.request("app.dispatch", { action: "Open" })
  await waitUntil(() => held.heldCount() === 1, "the build to start")
  await session.advanceTime(30_000)
  const { operation } = await session.client.request("app.wait", { operationId })
  expect(operation?.status).toBe("completed")
  expect(refusals).toEqual([expect.stringContaining("too long to build")])
  held.finish()
})

test("builds that outrun their deadline are limited, and free their place when they end", async () => {
  const held = heldCleanup()
  const { host, refusals } = stackApp({ acquire: held.finalizer })
  const session = await pool.open(host)
  for (let index = 0; index < UNFINISHED_SCREEN_WORK_MAX; index++) {
    const { operationId } = await session.client.request("app.dispatch", { action: "Open" })
    await waitUntil(() => held.heldCount() === index + 1, "the build to start")
    await session.advanceTime(30_000)
    await session.client.request("app.wait", { operationId })
  }
  const timedOut = refusals.length
  await session.raw.dispatchRaw("Open")
  expect(refusals.slice(timedOut)).toEqual([expect.stringContaining("still being built")])
  held.finish()
  await waitUntil(() => held.heldCount() === 0, "the builds to end")
  await nextTurn()
  await session.raw.dispatchRaw("Open")
  expect(refusals).toHaveLength(timedOut + 1)
})

test("builds that time out are stopped, and use up nothing", async () => {
  const spied = spyOn(console, "error").mockImplementation(() => undefined)
  const { host, refusals } = stackApp({ acquire: Effect.interruptible(Effect.never) })
  const session = await pool.open(host)
  for (let index = 0; index < UNFINISHED_SCREEN_WORK_MAX + 1; index++) {
    const { operationId } = await session.client.request("app.dispatch", { action: "Open" })
    await nextTurn()
    await session.advanceTime(30_000)
    await session.client.request("app.wait", { operationId })
    await nextTurn()
  }
  expect(refusals.filter((message) => message.includes("still being built"))).toEqual([])
  spied.mockRestore()
})

test("builds that are cancelled are stopped, and use up nothing", async () => {
  const { host, refusals } = stackApp({ acquire: Effect.interruptible(Effect.never) })
  const session = await pool.open(host)
  for (let index = 0; index < UNFINISHED_SCREEN_WORK_MAX + 1; index++) {
    const { operationId } = await session.client.request("app.dispatch", { action: "Open" })
    await nextTurn()
    await session.client.request("app.cancel", { operationId })
    await session.client.request("app.wait", { operationId })
    await nextTurn()
  }
  expect(refusals).toEqual([])
})

test("a session ending during an overdue cleanup is not a failure to report", async () => {
  const held = heldCleanup()
  const report = spyOn(console, "error").mockImplementation(() => undefined)
  const { host } = stackApp({ finalizer: held.finalizer })
  const session = await pool.open(host)
  await session.raw.dispatchRaw("Open")
  await session.client.request("app.dispatch", { action: "GoBack" })
  await waitUntil(() => held.heldCount() === 1, "the cleanup to start")
  await session.advanceTime(10_000)
  const ending = session.dispose()
  await nextTurn()
  held.finish()
  await ending
  await nextTurn()
  expect(report.mock.calls.filter((call) => !JSON.stringify(call).includes("too long"))).toEqual([])
  report.mockRestore()
})

test("a failed build's cleanup cannot hold navigation forever", async () => {
  const held = heldCleanup()
  const spied = spyOn(console, "error").mockImplementation(() => undefined)
  const { host } = stackApp({ finalizer: held.finalizer, failBuild: true })
  const session = await pool.open(host)
  const { operationId } = await session.client.request("app.dispatch", { action: "Open" })
  await waitUntil(() => held.heldCount() === 1, "the cleanup to start")
  await session.advanceTime(10_000)
  const { operation } = await session.client.request("app.wait", { operationId })
  expect(operation).toMatchObject({ status: "failed", error: { defect: true } })
  expect((await session.raw.dispatchRaw("Ping")).status).toBe("completed")
  held.finish()
  spied.mockRestore()
})

test("a refused push's cleanup cannot hold navigation forever", async () => {
  const held = heldCleanup()
  const spied = spyOn(console, "error").mockImplementation(() => undefined)
  const text = "x".repeat(NODE_STATE_CHARACTERS_MAX * 0.6)
  const { host, refusals } = stackApp({ text, finalizer: held.finalizer })
  const session = await pool.open(host)
  await session.raw.dispatchRaw("Open")
  const { operationId } = await session.client.request("app.dispatch", { action: "Open" })
  await waitUntil(() => held.heldCount() === 1, "the cleanup to start")
  const { tree } = await session.client.request("app.inspect", { tree: true })
  expect(tree?.filter(({ name }) => name === "Next")).toHaveLength(1)
  await session.advanceTime(10_000)
  await session.client.request("app.wait", { operationId })
  expect(refusals).toHaveLength(1)
  held.finish()
  spied.mockRestore()
})

test("a screen whose own state is too large is refused, not a crash", async () => {
  const text = "x".repeat(NODE_STATE_CHARACTERS_MAX + 1)
  const { host, refusals } = stackApp({ screenText: text })
  const session = await pool.open(host)
  expect((await session.raw.dispatchRaw("Open")).status).toBe("completed")
  expect(refusals).toHaveLength(1)
  expect((await session.client.request("app.inspect", {})).node?.name).toBe("Home")
})

test("a session's own failures reach the reporter its controller was given", async () => {
  const held = heldCleanup()
  const reported: Array<unknown> = []
  const { host } = stackApp({ finalizer: held.finalizer })
  const controller = await openController(host, {
    onBackgroundError: (error) => reported.push(error),
  })
  await controller.request("app.dispatch", { action: "Open", await: true })
  await controller.request("app.dispatch", { action: "GoBack" })
  await waitUntil(() => held.heldCount() === 1, "the cleanup to start")
  await controller.request("app.advanceTime", { durationMs: 10_000 })
  await waitUntil(() => reported.length === 1, "the overrun is reported")
  expect(String(reported[0])).toContain("too long to clean up")
  held.finish()
})

test("a cleanup that fails past its deadline is reported, and only then", async () => {
  const held = heldCleanup()
  const report = spyOn(console, "error").mockImplementation(() => undefined)
  const { host } = stackApp({ finalizer: held.finalizer })
  const session = await pool.open(host)
  await session.raw.dispatchRaw("Open")
  await session.client.request("app.dispatch", { action: "GoBack" })
  await waitUntil(() => held.heldCount() === 1, "the cleanup to start")
  await session.advanceTime(10_000)
  expect(JSON.stringify(report.mock.calls)).not.toContain("late cleanup failure")
  held.finish(Effect.die(new Error("late cleanup failure")))
  await waitUntil(
    () => JSON.stringify(report.mock.calls).includes("late cleanup failure"),
    "the late failure is reported",
  )
  report.mockRestore()
})

test("screens still cleaning up are limited, and free their place when they end", async () => {
  const held = heldCleanup()
  const spied = spyOn(console, "error").mockImplementation(() => undefined)
  const { host, refusals } = stackApp({ finalizer: held.finalizer })
  const session = await pool.open(host)
  for (let index = 0; index < UNFINISHED_SCREEN_WORK_MAX; index++) {
    expect((await session.raw.dispatchRaw("Open")).status).toBe("completed")
    expect(refusals).toEqual([])
    const { operationId } = await session.client.request("app.dispatch", { action: "GoBack" })
    await waitUntil(() => held.heldCount() === index + 1, "the cleanup to start")
    await session.advanceTime(10_000)
    await session.client.request("app.wait", { operationId })
  }
  await session.raw.dispatchRaw("Open")
  expect(refusals).toEqual(["Too many screens are still being built or cleaned up"])
  held.finish()
  await waitUntil(() => held.heldCount() === 0, "the cleanups to end")
  await nextTurn()
  await session.raw.dispatchRaw("Open")
  expect(refusals).toHaveLength(1)
  spied.mockRestore()
})

test("leaving a screen stops its work, whatever its cleanup is doing", async () => {
  const held = heldCleanup()
  let wrote = false
  const { host } = stackApp({
    finalizer: held.finalizer,
    stayWork: Effect.sleep("1 second").pipe(
      Effect.andThen(
        Effect.sync(() => {
          wrote = true
        }),
      ),
    ),
  })
  const session = await pool.open(host)
  await session.raw.dispatchRaw("Open")
  const { operationId } = await session.client.request("app.dispatch", { action: "Stay" })
  await session.client.request("app.dispatch", { action: "GoBack" })
  await waitUntil(() => held.heldCount() === 1, "the cleanup to start")
  await session.advanceTime(2_000)
  const { operation } = await session.client.request("app.wait", { operationId })
  expect(operation?.status).toBe("cancelled")
  expect(wrote).toBe(false)
  held.finish()
})

test("leaving a screen never leaves the app with nothing focused", async () => {
  const { host } = stackApp({})
  const session = await pool.open(host)
  await session.raw.dispatchRaw("Open")
  await session.raw.dispatchRaw("GoBack")
  const focuses = session.events.flatMap((event) =>
    event.type === "focus.changed" ? [event.nodeId] : [],
  )
  expect(focuses.slice(1)).not.toContain(null)
})

test("failed starts give their slots back", async () => {
  let failing = false
  const host: AppHost = {
    ...inventory,
    start: (name, options) =>
      failing ? Promise.reject(new Error("no database")) : inventory.start(name, options),
  }
  const controller = await openController(host)
  failing = true
  for (let index = 0; index < UNFINISHED_SESSIONS_MAX + 1; index++) {
    await expect(controller.request("app.reset", {})).rejects.toThrow("no database")
  }
})

test("a session whose methods need their object keeps them", async () => {
  const live = await inventory.start("inventory-with-products", { sessionId: "clocked" })
  class Clocked implements AppSession {
    readonly runtime = live.runtime
    private nowVirtualMs = 0
    async advanceTime(durationMs: number): Promise<number> {
      this.nowVirtualMs += durationMs
      return this.nowVirtualMs
    }
    dispose(): Promise<void> {
      return live.dispose()
    }
  }
  const host: AppHost = { ...inventory, start: async () => new Clocked() }
  const controller = await openController(host)
  expect(await controller.request("app.advanceTime", { durationMs: 5 })).toEqual({
    nowVirtualMs: 5,
  })
})

test("a shutdown happens after its reply, not before", async () => {
  const controller = await openController(inventory)
  const lines: Array<string> = []
  let linesAtShutdown = -1
  const connection = createConnection(controller, (line) => lines.push(line), {
    onShutdown: () => {
      linesAtShutdown = lines.length
    },
  })
  connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.shutdown" }))
  await waitUntil(() => linesAtShutdown !== -1, "the shutdown")
  expect(linesAtShutdown).toBe(1)
})

test("a disposal that fails after its deadline is still reported", async () => {
  const { timers, expire } = manualTimers()
  const reported: Array<unknown> = []
  let failDisposal: (error: Error) => void = () => undefined
  const host: AppHost = {
    ...inventory,
    start: async (name, options) => {
      const session = await inventory.start(name, options)
      return {
        ...session,
        dispose: () =>
          new Promise<void>((_, reject) => {
            failDisposal = reject
          }).finally(() => session.dispose()),
      }
    },
  }
  const controller = await openController(host, {
    timers,
    onBackgroundError: (error) => reported.push(error),
  })
  const reset = controller.request("app.reset", {}).catch((error: unknown) => error)
  await nextTurn()
  expire()
  expect(await reset).toBeInstanceOf(Error)
  expect(reported).toEqual([])
  failDisposal(new Error("late failure"))
  await waitUntil(() => reported.length === 1, "the late failure is reported")
})

test("draining waits for a batch's reply, and not only for its requests", async () => {
  const controller = await openController(inventory)
  const lines: Array<string> = []
  const connection = createConnection(controller, (line) => lines.push(line))
  const describe = (id: number) => ({ jsonrpc: "2.0", id, method: "app.describe", params: {} })
  connection.receive(JSON.stringify([describe(1), describe(2)]))
  // A batch's requests finish a little before its reply: every moment has to hold.
  const seen: Array<Promise<number>> = []
  while (lines.length === 0) {
    seen.push(connection.drained().then(() => lines.length))
    await Promise.resolve()
  }
  expect(new Set(await Promise.all(seen))).toEqual(new Set([1]))
})

test("a reply over the batch's share is refused, though it would fit a frame", async () => {
  const peer = { jsonrpc: "2.0", id: 1, method: "app.inspect", params: {} }
  const text = "x".repeat(BATCH_LARGE_REPLY_CHARACTERS_MAX + 1)
  const controller: Controller = {
    request: async () => ({ text }) as never,
    subscribe: async () => ({ unsubscribe: () => undefined, sessionId: "s", sequence: 0 }),
    close: async () => undefined,
  }
  const lines: Array<string> = []
  const connection = createConnection(controller, (line) => lines.push(line))
  connection.receive(JSON.stringify([peer]))
  await waitUntil(() => lines.length > 0, "the batch is answered")
  expect(JSON.parse(lines[0] ?? "")).toMatchObject([
    { id: 1, error: { code: ErrorCode.ResourceExhausted } },
  ])
})

test("an acknowledgment arrives even when a large reply has used the batch's share", async () => {
  const peer = { jsonrpc: "2.0", id: 1, method: "app.inspect", params: {} }
  const empty = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "" } })
  const text = "x".repeat(BATCH_LARGE_REPLY_CHARACTERS_MAX - empty.length)
  const controller: Controller = {
    request: async () => ({ text }) as never,
    subscribe: async () => ({ unsubscribe: () => undefined, sessionId: "s", sequence: 0 }),
    close: async () => undefined,
  }
  const lines: Array<string> = []
  const connection = createConnection(controller, (line) => lines.push(line))
  const subscribe = { ...peer, id: 2, method: "app.subscribe" }
  connection.receive(JSON.stringify([peer, subscribe]))
  await waitUntil(() => lines.length > 0, "the batch is answered")
  expect(JSON.parse(lines[0] ?? "")).toMatchObject([
    { id: 1, result: { text } },
    { id: 2, result: { subscriptionId: expect.any(String) } },
  ])
})

test("what a subscription gave up when it overflowed is there for the others", async () => {
  const large = "x".repeat(1024 * 1024)
  const listeners: Array<(event: RuntimeEvent) => void> = []
  let finishWait: () => void = () => undefined
  const controller: Controller = {
    request: async () => {
      await new Promise<void>((resolve) => {
        finishWait = resolve
      })
      return { ok: true } as never
    },
    subscribe: async (listener) => {
      listeners.push(listener)
      return { unsubscribe: () => undefined, sessionId: "s", sequence: 0 }
    },
    close: async () => undefined,
  }
  const lines: Array<string> = []
  const connection = createConnection(controller, (line) => lines.push(line), {
    encodeEvent: (event) => (event.type === "resync.required" ? JSON.stringify(event) : large),
  })
  const call = (id: number, method: string) => ({ jsonrpc: "2.0", id, method, params: {} })
  connection.receive(
    JSON.stringify([call(1, "app.subscribe"), call(2, "app.subscribe"), call(3, "app.wait")]),
  )
  await nextTurn()
  const [first, second] = listeners
  const overflow = Math.floor(HELD_EVENT_CHARACTERS_MAX / large.length) + 1
  for (let sequence = 1; sequence <= overflow; sequence++) {
    first?.(startedEvent(sequence))
  }
  second?.(startedEvent(1))
  finishWait()
  await nextTurn()
  const delivered = lines.filter(
    (line) => line.includes(EVENT_NOTIFICATION) && line.includes("sub-2"),
  )
  expect(delivered).toHaveLength(1)
  expect(delivered[0]).not.toContain("resync.required")
})

test("subscriptions on one connection share what can be held for them", async () => {
  const large = "x".repeat(1024 * 1024)
  const listeners: Array<(event: RuntimeEvent) => void> = []
  let finishWait: () => void = () => undefined
  const controller: Controller = {
    request: async () => {
      await new Promise<void>((resolve) => {
        finishWait = resolve
      })
      return { ok: true } as never
    },
    subscribe: async (listener) => {
      listeners.push(listener)
      return { unsubscribe: () => undefined, sessionId: "s", sequence: 0 }
    },
    close: async () => undefined,
  }
  const lines: Array<string> = []
  const connection = createConnection(controller, (line) => lines.push(line), {
    encodeEvent: (event) => (event.type === "resync.required" ? JSON.stringify(event) : large),
  })
  const call = (id: number, method: string) => ({ jsonrpc: "2.0", id, method, params: {} })
  connection.receive(
    JSON.stringify([call(1, "app.subscribe"), call(2, "app.subscribe"), call(3, "app.wait")]),
  )
  await nextTurn()
  const perSubscription = Math.ceil(HELD_EVENT_CHARACTERS_MAX / large.length / 2) + 1
  for (let sequence = 1; sequence <= perSubscription; sequence++) {
    for (const listener of listeners) {
      listener(startedEvent(sequence))
    }
  }
  finishWait()
  await nextTurn()
  expect(lines.join("\n")).toContain("resync.required")
})

test("a size refusal during navigation cannot hide a cleanup defect", async () => {
  const text = "x".repeat(NODE_STATE_CHARACTERS_MAX * 0.6)
  let cleanups = 0
  const finalizer = Effect.suspend(() => {
    cleanups++
    return cleanups === 1 ? Effect.die(new Error("cleanup beside limit")) : Effect.void
  })
  const { host, refusals } = stackApp({ text, finalizer })
  const session = await pool.open(host)
  expect(await session.raw.dispatchRaw("Open")).toMatchObject({ status: "completed" })
  expect(await session.raw.dispatchRaw("Open")).toMatchObject({
    status: "failed",
    error: { defect: true, message: "cleanup beside limit" },
  })
  expect(refusals).toEqual([])
})

test("a screen build size refusal cannot hide an acquired resource cleanup defect", async () => {
  const { host, refusals } = stackApp({
    screenText: "x".repeat(NODE_STATE_CHARACTERS_MAX + 1),
    acquire: Effect.void,
    onRelease: () => {
      throw new Error("build cleanup beside limit")
    },
  })
  const session = await pool.open(host)
  expect(await session.raw.dispatchRaw("Open")).toMatchObject({
    status: "failed",
    error: { defect: true, message: "build cleanup beside limit" },
  })
  expect(refusals).toEqual([])
  expect(session.raw.state).toEqual({})
})
