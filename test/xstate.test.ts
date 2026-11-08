import { expect, test } from "bun:test"
import { ErrorCode, type RuntimeEvent } from "@reflex/protocol"
import { createController } from "@reflex/runtime"
import { waitFor } from "xstate"
import { createCounterSession, xstateBackend } from "./xstate-counter.ts"

const deferred = () => {
  let resolve: (count: number) => void = () => undefined
  const promise = new Promise<number>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("an event operation completes before its invoked promise; snapshots publish its later result", async () => {
  const load = deferred()
  const session = createCounterSession("async-counter", () => load.promise)
  const { runtime, actor } = session
  const events: RuntimeEvent[] = []
  runtime.subscribe((event) => events.push(event))
  try {
    const before = runtime.inspect().node?.revision
    const accepted = await runtime.dispatch({ action: "Load" })
    expect(accepted.status).toBe("running")
    expect(
      (await runtime.wait({ operationId: accepted.operationId, timeoutMs: 1000 })).operation,
    ).toMatchObject({ status: "completed" })
    expect(actor.getSnapshot().value).toBe("loading")
    expect(runtime.stateOf("Counter")).toEqual({ count: 0 })
    expect(runtime.inspect().node?.revision).not.toBe(before)
    expect(runtime.inspect().node?.actions.Load?.available).toBe(false)
    // Protocol idle counts operations, not all work in an actor system.
    await runtime.wait({ idle: true, timeoutMs: 1000 })
    const finishedIndex = events.findIndex((event) => event.type === "operation.finished")
    expect(finishedIndex).toBeGreaterThanOrEqual(0)
    const changed = runtime.wait({ match: { count: 9 }, timeoutMs: 1000 })
    load.resolve(9)
    await changed
    expect(actor.getSnapshot().value).toBe("ready")
    expect(events.slice(finishedIndex + 1)).toContainEqual(
      expect.objectContaining({ type: "state.changed", state: { count: 9 } }),
    )
    expect(runtime.operation(accepted.operationId).status).toBe("completed")
  } finally {
    runtime.close()
    await session.dispose()
  }
})

test("dispose stops the actor and its invoked child; late results and sends publish nothing", async () => {
  const load = deferred()
  let signal: AbortSignal | undefined
  const session = createCounterSession("disposed-counter", (childSignal) => {
    signal = childSignal
    return load.promise
  })
  const events: RuntimeEvent[] = []
  session.runtime.subscribe((event) => events.push(event))
  let snapshots = 0
  session.actor.subscribe(() => snapshots++)
  await session.runtime.dispatch({ action: "Load" })
  await session.runtime.wait({ idle: true, timeoutMs: 1000 })
  await session.dispose()
  expect(signal?.aborted).toBe(true)
  expect(session.actor.getSnapshot().status).toBe("stopped")
  const published = events.length
  const observed = snapshots
  load.resolve(99)
  await load.promise
  // Drain the promise actor's already queued resolution; no wall-clock sleep.
  await Promise.resolve()
  session.actor.send({ type: "Add", by: 1 })
  expect(session.actor.getSnapshot().context.count).toBe(0)
  expect(snapshots).toBe(observed)
  expect(events).toHaveLength(published)
  session.runtime.close()
})

test("reset and controller close dispose their own actor sessions", async () => {
  const sessions: ReturnType<typeof createCounterSession>[] = []
  const controller = await createController({
    ...xstateBackend,
    async start(_, { sessionId }) {
      const session = createCounterSession(sessionId)
      sessions.push(session)
      return session
    },
  })
  try {
    const old = await controller.request("app.inspect", {})
    await controller.request("app.dispatch", { action: "Add", input: { by: 4 } })
    await controller.request("app.reset", {})
    expect(sessions[0]?.actor.getSnapshot().status).toBe("stopped")
    expect(sessions[0]?.runtime.closed).toBe(true)
    const fresh = await controller.request("app.inspect", {})
    expect(fresh.node?.state).toEqual({ count: 0 })
    expect(fresh.node?.id).not.toBe(old.node?.id)
  } finally {
    await controller.close()
  }
  expect(sessions[1]?.actor.getSnapshot().status).toBe("stopped")
})

test("validation matches the published schemas before any event is sent", async () => {
  const session = createCounterSession("validation-counter")
  try {
    for (const input of [null, [], {}, { by: 1.5 }, { by: 1, extra: true }]) {
      await expect(session.runtime.dispatch({ action: "Add", input })).rejects.toMatchObject({
        code: ErrorCode.InvalidInput,
      })
    }
    await expect(
      session.runtime.dispatch({ action: "Load", input: { extra: true } }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidInput })
    expect(session.runtime.stateOf("Counter")).toEqual({ count: 0 })
  } finally {
    session.runtime.close()
    await session.dispose()
  }
})

test("a child failure is handled by the machine after the event operation has completed", async () => {
  let reject: (error: Error) => void = () => undefined
  const failed = new Promise<number>((_, fail) => {
    reject = fail
  })
  const session = createCounterSession("failed-child", () => failed)
  try {
    const accepted = await session.runtime.dispatch({ action: "Load" })
    await session.runtime.wait({ operationId: accepted.operationId, timeoutMs: 1000 })
    expect(session.actor.getSnapshot().value).toBe("loading")
    const ready = waitFor(session.actor, (snapshot) => snapshot.matches("ready"), { timeout: 1000 })
    reject(new Error("service failed"))
    await ready
    expect(session.runtime.stateOf("Counter")).toEqual({ count: 0 })
    expect(session.runtime.operation(accepted.operationId).status).toBe("completed")
  } finally {
    session.runtime.close()
    await session.dispose()
  }
})
