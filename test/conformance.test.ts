/**
 * The reusability claim, tested: one suite, three unrelated backends, and the first again
 * served live as a device serves it. If any needs a special case here, the abstraction
 * has leaked.
 */
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { type AccessPolicy, ErrorCode, FULL_CONTROL } from "@reflex/protocol"
import { type Controller, createController, restrictController } from "@reflex/runtime/internal"
import { createTestAppPool } from "@reflex/test"
import { plainBackend } from "../examples/plain/src/app.ts"
import effectBackend, { COUNTER_APP_MODULE } from "./counter-app.ts"
import { openBridged } from "./live-bridge.ts"
import { xstateBackend } from "./xstate-counter.ts"

if (process.platform === "win32") {
  setDefaultTimeout(30_000) // Real daemon startup includes Windows ACL verification.
}

const pool = createTestAppPool()
afterEach(pool.disposeAll)

const BACKENDS = [
  ["Effect", () => createController(effectBackend)],
  ["Zustand + Standard Schema", () => createController(plainBackend)],
  ["XState", () => createController(xstateBackend)],
  // Served as a device serves it, over a real WebSocket bridge: what the CLI drives live.
  ["Effect, live through the bridge,", () => openBridged(COUNTER_APP_MODULE)],
  [
    "Zustand, live through the bridge",
    () => openBridged(fileURLToPath(new URL("./plain-conformance.ts", import.meta.url).href)),
  ],
] as const

const opener =
  (controllerOf: () => Promise<Controller>) =>
  (access: AccessPolicy = FULL_CONTROL) =>
    pool.openOn(async () => restrictController(await controllerOf(), access))

describe.each(BACKENDS)("%s backend", (_, controllerOf) => {
  const open = opener(controllerOf)

  test("inspect exposes state and a JSON Schema per action", async () => {
    const app = await open()
    const { node } = await app.inspect()
    expect(node).toMatchObject({ name: "Counter", type: "screen", state: { count: 0 } })
    expect(node?.actions.Add?.inputSchema).toMatchObject({
      type: "object",
      properties: { by: { type: "integer" } },
      required: ["by"],
    })
  })

  test("dispatch runs the action and subscribers see the change in order", async () => {
    const app = await open()
    await app.raw.dispatchRaw("Add", { by: 2 })
    await app.raw.dispatchRaw("Add", { by: 3 })
    expect(app.raw.state).toEqual({ count: 5 })

    const changes = app.events.flatMap((e) => (e.type === "state.changed" ? [e] : []))
    expect(changes.map((e) => e.state)).toEqual([{ count: 2 }, { count: 5 }])
    const sequences = app.events.map((e) => e.sequence)
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
  })

  test("availability follows state", async () => {
    const app = await open()
    expect(await app.raw.dispatchRaw("Reset").catch((error: unknown) => error)).toMatchObject({
      code: ErrorCode.ActionUnavailable,
    })
    await app.raw.dispatchRaw("Add", { by: 1 })
    expect((await app.raw.dispatchRaw("Reset")).status).toBe("completed")
  })

  test("invalid input and unknown actions are rejected without touching state", async () => {
    const app = await open()
    expect(
      await app.raw.dispatchRaw("Add", { by: "x" }).catch((error: unknown) => error),
    ).toMatchObject({
      code: ErrorCode.InvalidInput,
    })
    expect(await app.raw.dispatchRaw("Nope").catch((error: unknown) => error)).toMatchObject({
      code: ErrorCode.ActionNotFound,
    })
    await app.inspect()
    expect(app.raw.state).toEqual({ count: 0 })
  })

  test("stale revisions are rejected", async () => {
    const app = await open()
    const { node } = await app.inspect()
    await app.raw.dispatchRaw("Add", { by: 1 })
    expect(
      await app.client
        .request("app.dispatch", {
          action: "Add",
          input: { by: 1 },
          expectedRevision: Number(node?.revision),
        })
        .catch((error: unknown) => error),
    ).toMatchObject({ code: ErrorCode.StaleRevision })
  })

  test("wait resolves on a later state and times out with context", async () => {
    const app = await open()
    const waiting = app.waitFor({ match: { count: 7 } })
    await app.raw.dispatchRaw("Add", { by: 7 })
    await waiting
    expect(
      await app.waitFor({ match: { count: 8 }, timeoutMs: 10 }).catch((error: unknown) => error),
    ).toMatchObject({
      code: ErrorCode.WaitTimeout,
      data: { state: { count: 7 } },
    })
  })
})

describe.each(BACKENDS)("%s backend, held to an access policy,", (_, controllerOf) => {
  const open = opener(controllerOf)

  test("an observer reads, waits and watches, and changes nothing", async () => {
    const app = await open({ kind: "observe" })
    const { node } = await app.inspect()
    expect(node?.actions.Add).toMatchObject({
      available: false,
      unavailableReason: "Not permitted on this connection",
    })
    expect(await app.client.request("app.describe", {})).toMatchObject({
      access: { kind: "observe" },
    })
    await expect(app.raw.dispatchRaw("Add", { by: 1 })).rejects.toMatchObject({
      code: ErrorCode.NotPermitted,
    })
    await expect(app.reset()).rejects.toMatchObject({ code: ErrorCode.NotPermitted })
    await app.inspect()
    expect(app.raw.state).toEqual({ count: 0 })
    // Observers may wait. One that is already satisfied keeps this free of timing.
    await app.waitFor({ match: { count: 0 } })
  })

  test("an allowlist runs the actions it names, and only those", async () => {
    const app = await open({ kind: "actions", actions: ["Add"] })
    await app.raw.dispatchRaw("Add", { by: 2 })
    expect(app.raw.state).toEqual({ count: 2 })
    await expect(app.raw.dispatchRaw("Reset")).rejects.toMatchObject({
      code: ErrorCode.NotPermitted,
    })
    await expect(app.client.request("app.advanceTime", { durationMs: 1 })).rejects.toMatchObject({
      code: ErrorCode.NotPermitted,
    })
    await app.inspect()
    expect(app.raw.state).toEqual({ count: 2 })
  })
})
