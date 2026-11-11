import { afterEach, expect, test } from "bun:test"
import { defineApp, defineNavigation, Screen } from "@reflex/effect"
import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
import {
  BRIDGE_WAITERS_MAX,
  CANCEL_NOTIFICATION,
  ErrorCode,
  type RuntimeEvent,
} from "@reflex/protocol"
import {
  type BridgeController,
  type Client,
  createBridgeController,
  createClient,
  createConnection,
  createLoopbackClient,
  type EventListener,
} from "@reflex/rpc"
import { type Controller, createController, type Timers } from "@reflex/runtime/internal"
import { nextTurn, waitUntil } from "@reflex/test"
import * as Schema from "effect/Schema"

const Counter = Screen.define("Counter", {
  initial: () => ({ count: 0 }),
  state: Schema.Struct({ count: Schema.Int }),
  actions: (action) => ({
    Add: action({
      input: Schema.Struct({ by: Schema.Int }),
      handler: ({ by }, { state }) => state.update((s) => ({ count: s.count + by })),
    }),
  }),
})

const Nav = defineNavigation({ Counter })
const host = defineApp({
  name: "counter",
  navigation: Nav.implement([Counter], { initial: Counter }),
})[APP_HOST_ADAPTER]

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

/** A clock that moves only when told to. */
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

const bridge = (options: { readonly timers?: Timers; readonly onClose?: () => void } = {}) => {
  const reported: Array<unknown> = []
  const bridged = createBridgeController({
    disconnectedMessage: "Connect an app",
    onBackgroundError: (error) => reported.push(error),
    ...options,
  })
  cleanups.push(() => bridged.close())
  return { bridged, reported }
}

/** An app, as far as a bridge can tell: a client that reaches a controller. */
const app = async (): Promise<{ readonly controller: Controller; readonly client: Client }> => {
  const controller = await createController(host, { sessionPrefix: `s${cleanups.length}` })
  cleanups.push(() => controller.close())
  return { controller, client: createLoopbackClient(controller) }
}

/** A client that answers only when the test says. */
const scriptedClient = () => {
  const listeners = new Set<EventListener>()
  const requests: Array<{
    readonly method: string
    readonly resolve: (result: unknown) => void
    readonly reject: (error: Error) => void
  }> = []
  let ended = false
  const client = {
    request: (method: string) =>
      new Promise((resolve, reject) => {
        requests.push({ method, resolve, reject })
      }),
    onEvent: (listener: EventListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ended: new Promise<Error | null>(() => undefined),
    get isEnded() {
      return ended
    },
    close: () => {
      ended = true
      for (const { reject } of requests) {
        reject(new Error("closed"))
      }
    },
  } as unknown as Client
  const emit = (event: RuntimeEvent, subscriptionId: string) => {
    for (const listener of listeners) {
      listener(event, subscriptionId)
    }
  }
  return { client, requests, emit }
}

const add = (bridged: BridgeController, by: number) =>
  bridged.request("app.dispatch", { action: "Add", input: { by }, await: true })

const counts = (events: ReadonlyArray<RuntimeEvent>) =>
  events.flatMap((event) => (event.type === "state.changed" ? [event.state] : []))

test("a request waits for an app, and says how to connect one if none comes", async () => {
  const { timers, expire } = manualTimers()
  const { bridged } = bridge({ timers })
  const describing = bridged.request("app.describe", {})
  expire()
  const refusal = await describing.catch((error: unknown) => error)
  expect(refusal).toMatchObject({ code: ErrorCode.SessionClosed, message: "Connect an app" })
})

test("a request waiting for an app lands once one connects", async () => {
  const { bridged } = bridge()
  const describing = bridged.request("app.describe", {})
  bridged.attach((await app()).client)
  expect(await describing).toMatchObject({ app: "counter" })
  expect(bridged.connected).toBe(true)
})

test("requests waiting for an app are bounded", async () => {
  const { timers } = manualTimers()
  const { bridged } = bridge({ timers })
  for (let index = 0; index < BRIDGE_WAITERS_MAX; index++) {
    bridged.request("app.describe", {}).catch(() => undefined)
  }
  const refusal = await bridged.request("app.describe", {}).catch((error: unknown) => error)
  expect(refusal).toMatchObject({ code: ErrorCode.ResourceExhausted })
})

test("the app's own refusals pass through unchanged", async () => {
  const { bridged } = bridge()
  bridged.attach((await app()).client)
  const refusal = await bridged
    .request("app.dispatch", { action: "Nope" })
    .catch((error: unknown) => error)
  expect(refusal).toMatchObject({ code: ErrorCode.ActionNotFound })
})

test("an app lost mid-request is reported as maybe having run", async () => {
  const { bridged } = bridge()
  const scripted = scriptedClient()
  bridged.attach(scripted.client)
  const dispatching = bridged.request("app.dispatch", { action: "Add" })
  await nextTurn()
  bridged.detach(scripted.client)
  const refusal = await dispatching.catch((error: unknown) => error)
  expect(refusal).toMatchObject({ code: ErrorCode.SessionClosed })
  expect(String(refusal)).toContain("may or may not have run")
})

test("a subscriber resumes after a reconnect to the same session, repeating nothing", async () => {
  const { bridged } = bridge()
  const { controller, client } = await app()
  bridged.attach(client)
  const events: Array<RuntimeEvent> = []
  await bridged.subscribe((event) => events.push(event))
  await add(bridged, 1)
  // The same app, on a new connection: what a dropped Wi-Fi link looks like.
  const again = createLoopbackClient(controller)
  bridged.attach(again)
  expect(client.isEnded).toBe(true)
  await add(bridged, 2)
  await waitUntil(() => counts(events).length === 2, "both changes arrive")
  expect(counts(events)).toEqual([{ count: 1 }, { count: 3 }])
  expect(events.some((event) => event.type === "resync.required")).toBe(false)
})

test("a subscriber is told to resynchronize when the app comes back as a new session", async () => {
  const { bridged } = bridge()
  const first = await app()
  bridged.attach(first.client)
  const events: Array<RuntimeEvent> = []
  const { sessionId } = await bridged.subscribe((event) => events.push(event))
  const reloaded = await app()
  bridged.attach(reloaded.client)
  await waitUntil(
    () => events.some((event) => event.type === "resync.required"),
    "the subscriber hears of it",
  )
  const resync = events.find((event) => event.type === "resync.required")
  expect(resync?.sessionId).not.toBe(sessionId)
  await add(bridged, 4)
  await waitUntil(() => counts(events).length === 1, "the new session's change arrives")
  expect(counts(events)).toEqual([{ count: 4 }])
})

test("events that arrive before their subscription's reply are delivered after it", async () => {
  const { bridged } = bridge()
  const scripted = scriptedClient()
  bridged.attach(scripted.client)
  const events: Array<RuntimeEvent> = []
  const subscribing = bridged.subscribe((event) => events.push(event))
  await nextTurn()
  const event: RuntimeEvent = {
    type: "focus.changed",
    nodeId: null,
    sessionId: "s",
    sequence: 3,
    revision: 1,
  }
  scripted.emit(event, "sub-1")
  scripted.emit({ ...event, sequence: 4 }, "sub-other")
  expect(events).toEqual([])
  scripted.requests[0]?.resolve({ subscriptionId: "sub-1", sessionId: "s", sequence: 2 })
  await subscribing
  expect(events).toEqual([event])
})

test("an unsubscribed subscriber hears nothing more", async () => {
  const { bridged } = bridge()
  bridged.attach((await app()).client)
  const events: Array<RuntimeEvent> = []
  const { unsubscribe } = await bridged.subscribe((event) => events.push(event))
  unsubscribe()
  await add(bridged, 1)
  await nextTurn()
  expect(counts(events)).toEqual([])
})

test("closing refuses waiting requests and releases whatever apps dial in through", async () => {
  const { timers } = manualTimers()
  let released = 0
  const bridged = createBridgeController({
    disconnectedMessage: "Connect an app",
    timers,
    onClose: () => {
      released++
    },
  })
  const describing = bridged.request("app.describe", {})
  await bridged.close()
  await bridged.close()
  expect(await describing.catch((error: unknown) => error)).toMatchObject({
    code: ErrorCode.SessionClosed,
  })
  expect(released).toBe(1)
  const late = scriptedClient()
  bridged.attach(late.client)
  expect(late.client.isEnded).toBe(true)
})

test("a first subscribe whose reply beats a replacement moves to the new app", async () => {
  const { bridged } = bridge()
  const first = scriptedClient()
  const second = scriptedClient()
  bridged.attach(first.client)
  const events: Array<RuntimeEvent> = []
  const subscribing = bridged.subscribe((event) => events.push(event))
  await nextTurn()
  // The reply settles, and before its continuation runs another app connects.
  first.requests[0]?.resolve({ subscriptionId: "old", sessionId: "s", sequence: 2 })
  bridged.attach(second.client)
  await subscribing
  await nextTurn()
  const resumed = second.requests.find(({ method }) => method === "app.subscribe")
  expect(resumed).toBeDefined()
  resumed?.resolve({ subscriptionId: "new", sessionId: "s", sequence: 2 })
  await nextTurn()
  const event: RuntimeEvent = {
    type: "focus.changed",
    nodeId: null,
    sessionId: "s",
    sequence: 3,
    revision: 1,
  }
  second.emit(event, "new")
  expect(events).toEqual([event])
})

test("a caller that has already gone neither waits for an app nor reaches one", async () => {
  const { timers } = manualTimers()
  const { bridged } = bridge({ timers })
  const gone = AbortSignal.abort()
  const waiting = await bridged
    .request("app.describe", {}, { signal: gone })
    .catch((error: unknown) => error)
  expect(waiting).toMatchObject({ code: ErrorCode.SessionClosed })
  const scripted = scriptedClient()
  bridged.attach(scripted.client)
  const forwarded = await bridged
    .request("app.describe", {}, { signal: gone })
    .catch((error: unknown) => error)
  expect(forwarded).toMatchObject({ code: ErrorCode.SessionClosed })
  expect(scripted.requests).toHaveLength(0)
})

test("a cancelled request is answered at once, and its wait ends on the server", async () => {
  const { controller } = await app()
  const lines: Array<string> = []
  const connection = createConnection(controller, (line) => lines.push(line))
  cleanups.push(() => connection.close())
  const wait = { focus: "Never", timeoutMs: 600_000 }
  connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "app.wait", params: wait }))
  connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "app.wait", params: wait }))
  await nextTurn()
  connection.receive(
    JSON.stringify({ jsonrpc: "2.0", method: CANCEL_NOTIFICATION, params: { id: 7 } }),
  )
  await waitUntil(() => lines.length === 1, "the cancelled request is answered")
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({
    id: 7,
    error: { code: ErrorCode.SessionClosed },
  })
  // Only that one: its sibling is still waiting.
  await nextTurn()
  expect(lines).toHaveLength(1)
})

test("a caller going away mid-request tells the app to stop waiting for it", async () => {
  const { bridged } = bridge()
  const sent: Array<unknown> = []
  const { controller } = await app()
  const connection = createConnection(controller, (line) =>
    queueMicrotask(() => client.receive(line)),
  )
  const client = createClient({
    send: (line) => {
      sent.push(JSON.parse(line))
      queueMicrotask(() => connection.receive(line))
    },
    close: () => connection.close(),
  })
  bridged.attach(client)
  const caller = new AbortController()
  const waiting = bridged
    .request("app.wait", { focus: "Never", timeoutMs: 600_000 }, { signal: caller.signal })
    .catch((error: unknown) => error)
  await nextTurn()
  caller.abort()
  expect(await waiting).toMatchObject({ code: ErrorCode.SessionClosed })
  expect(sent.at(-1)).toMatchObject({ method: CANCEL_NOTIFICATION, params: { id: 1 } })
})
