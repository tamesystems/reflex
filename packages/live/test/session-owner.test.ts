import { expect, test } from "bun:test"
import { UNFINISHED_SESSIONS_MAX, ErrorCode } from "@reflex/protocol"
import { type AppHost, type AppSession, createRuntime, type Timers } from "@reflex/runtime/internal"
import { nextTurn } from "../../../test/support.ts"
import { type SessionLifecycle, SessionOwner } from "../src/session-owner.ts"

/** Starts that finish when the test says, and a clock that moves when it says. */
const setup = () => {
  const lifecycles: Array<SessionLifecycle> = []
  const reported: Array<unknown> = []
  const pendingStarts: Array<{
    readonly resolve: (session: AppSession) => void
    readonly reject: (error: Error) => void
  }> = []
  const disposed: Array<string> = []
  const expiries = new Set<() => void>()
  const timers: Timers = {
    setTimeout: (callback) => {
      expiries.add(callback)
      return callback
    },
    clearTimeout: (handle) => {
      expiries.delete(handle as () => void)
    },
  }
  const host: AppHost = {
    name: "test",
    scenarios: [{ name: "default", virtualTime: false }],
    defaultScenario: "default",
    start: () =>
      new Promise((resolve, reject) => {
        pendingStarts.push({ resolve, reject })
      }),
  }
  const session = (sessionId: string): AppSession => ({
    runtime: createRuntime({ sessionId }),
    dispose: async () => {
      disposed.push(sessionId)
    },
  })
  const owner = new SessionOwner({
    timers,
    onBackgroundError: (error) => reported.push(error),
    onChange: (lifecycle) => lifecycles.push(lifecycle),
  })
  const expire = () => {
    for (const callback of [...expiries]) {
      expiries.delete(callback)
      callback()
    }
  }
  return { owner, host, lifecycles, reported, pendingStarts, disposed, session, expire }
}

test("a session that starts goes live, and ends when released", async () => {
  const { owner, host, lifecycles, pendingStarts, disposed, session } = setup()
  const release = owner.start(host, undefined)
  pendingStarts[0]?.resolve(session("a"))
  await nextTurn()
  expect(lifecycles.map(({ kind }) => kind)).toEqual(["starting", "live"])
  release()
  await nextTurn()
  expect(disposed).toEqual(["a"])
})

test("a start replaced while pending is ended, and never goes live", async () => {
  const { owner, host, lifecycles, pendingStarts, disposed, session } = setup()
  const release = owner.start(host, undefined)
  release()
  pendingStarts[0]?.resolve(session("a"))
  await nextTurn()
  expect(lifecycles.map(({ kind }) => kind)).toEqual(["starting"])
  expect(disposed).toEqual(["a"])
})

test("a replaced start's failure leaves the newer session alone", async () => {
  const { owner, host, lifecycles, reported, pendingStarts, session } = setup()
  const release = owner.start(host, undefined)
  release()
  owner.start(host, undefined)
  pendingStarts[1]?.resolve(session("b"))
  await nextTurn()
  pendingStarts[0]?.reject(new Error("too late"))
  await nextTurn()
  expect(lifecycles.at(-1)?.kind).toBe("live")
  expect(reported).toHaveLength(1)
})

test("a failure of the current start is the provider's to show", async () => {
  const { owner, host, lifecycles, pendingStarts } = setup()
  owner.start(host, undefined)
  pendingStarts[0]?.reject(new Error("no"))
  await nextTurn()
  expect(lifecycles.at(-1)).toMatchObject({ kind: "failed" })
})

test("a start past its deadline fails, and is ended if it arrives later", async () => {
  const { owner, host, lifecycles, pendingStarts, disposed, session, expire } = setup()
  owner.start(host, undefined)
  await nextTurn()
  expire()
  await nextTurn()
  expect(lifecycles.at(-1)).toMatchObject({ kind: "failed" })
  pendingStarts[0]?.resolve(session("late"))
  await nextTurn()
  expect(disposed).toEqual(["late"])
})

test("a start past its deadline still counts until it is really over", async () => {
  const { owner, host, lifecycles, pendingStarts, expire } = setup()
  for (let index = 0; index < UNFINISHED_SESSIONS_MAX + 1; index++) {
    owner.start(host, undefined)
    await nextTurn()
    expire()
    await nextTurn()
  }
  const countBefore = pendingStarts.length
  owner.start(host, undefined)
  await nextTurn()
  expect(pendingStarts).toHaveLength(countBefore)
  expect(lifecycles.at(-1)).toMatchObject({ cause: { code: ErrorCode.ResourceExhausted } })
})

test("disposals that never finish cannot pile up either", async () => {
  const { owner, host, lifecycles, pendingStarts, session } = setup()
  const never = (id: string): AppSession => ({
    ...session(id),
    dispose: () => new Promise(() => undefined),
  })
  for (let index = 0; index < UNFINISHED_SESSIONS_MAX + 1; index++) {
    const release = owner.start(host, undefined)
    pendingStarts.at(-1)?.resolve(never(`s${index}`))
    await nextTurn()
    release()
    await nextTurn()
  }
  owner.start(host, undefined)
  expect(lifecycles.at(-1)).toMatchObject({ cause: { code: ErrorCode.ResourceExhausted } })
})

test("a finished disposal gives its slot back", async () => {
  const { owner, host, lifecycles, pendingStarts, session } = setup()
  for (let index = 0; index < UNFINISHED_SESSIONS_MAX + 3; index++) {
    const release = owner.start(host, undefined)
    pendingStarts.at(-1)?.resolve(session(`s${index}`))
    await nextTurn()
    release()
    await nextTurn()
  }
  expect(lifecycles.some(({ kind }) => kind === "failed")).toBe(false)
})

test("replacing starts that never finish cannot pile them up", async () => {
  const { owner, host, lifecycles, pendingStarts } = setup()
  for (let index = 0; index < UNFINISHED_SESSIONS_MAX + 2; index++) {
    owner.start(host, undefined)()
  }
  expect(pendingStarts).toHaveLength(UNFINISHED_SESSIONS_MAX + 1)
  expect(lifecycles.at(-1)).toMatchObject({
    kind: "failed",
    cause: { code: ErrorCode.ResourceExhausted },
  })
})

test("a session is given the owner's reporter for its own failures", async () => {
  const given: Array<unknown> = []
  const onBackgroundError = () => undefined
  const host: AppHost = {
    name: "host",
    scenarios: [],
    defaultScenario: "default",
    start: (_, options) => {
      given.push(options.onBackgroundError)
      return new Promise(() => undefined)
    },
  }
  const owner = new SessionOwner({
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    onBackgroundError,
    onChange: () => undefined,
  })
  owner.start(host, undefined)
  expect(given).toEqual([onBackgroundError])
})
