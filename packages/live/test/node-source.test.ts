import { expect, test } from "bun:test"
import { ErrorCode } from "@reflex/protocol"
import { createRuntime, mountStore } from "@reflex/runtime/internal"
import { nodeSource, reportFocus } from "../src/node-source.ts"

test("generic source binds an adapter without a live object and caches by revision", async () => {
  const runtime = createRuntime({ sessionId: "generic" })
  let count = 0
  let changed: () => void = () => undefined
  const id = runtime.nextId("service", "Bare")
  const unregister = runtime.register({
    id,
    type: "service",
    name: "Bare",
    snapshot: () => ({ count }),
    describeActions: () => ({ Add: { available: true, inputSchema: {} } }),
    subscribe: (listener) => {
      changed = listener
      return () => undefined
    },
    prepare: () => () => {
      count++
      changed()
      return { done: Promise.resolve({ status: "completed" }), cancel: () => undefined }
    },
  })
  const source = nodeSource(runtime, id)
  expect(source.getSnapshot()).toBe(source.getSnapshot())
  let notifications = 0
  const stop = source.subscribe(() => notifications++)
  await source.send("Add")
  expect(notifications).toBe(1)
  expect(source.getSnapshot()).toEqual({ count: 1 })
  unregister()
  expect(notifications).toBe(2)
  expect(source.getSnapshot()).toEqual({ count: 1 })
  stop()
})

test("external router focus gates screens; old cleanup cannot clear newer focus", async () => {
  const runtime = createRuntime({ sessionId: "focus" })
  const store = { getState: () => 0, subscribe: () => () => undefined }
  const mount = (name: string) =>
    mountStore(runtime, {
      name,
      type: "screen",
      store,
      project: (s) => s,
      actions: { Run: { handler: () => undefined } },
    })
  const first = mount("First")
  const second = mount("Second")
  await expect(first.dispatchRaw("Run")).rejects.toMatchObject({
    code: ErrorCode.ActionUnavailable,
  })
  const blurFirst = reportFocus(runtime, first.id)
  expect((await first.dispatchRaw("Run")).status).toBe("completed")
  const blurSecond = reportFocus(runtime, second.id)
  blurFirst()
  expect(runtime.focus).toBe(second.id)
  await expect(first.dispatchRaw("Run")).rejects.toMatchObject({
    code: ErrorCode.ActionUnavailable,
  })
  blurSecond()
  expect(runtime.focus).toBeNull()
  first.dispose()
  second.dispose()
})

test("existing-router focus starts Effect onFocus once per arrival", async () => {
  const { defineCapability, mount } = await import("@reflex/effect")
  const { Registry } = await import("@reflex/effect/internal")
  const Effect = await import("effect/Effect")
  const Schema = await import("effect/Schema")
  const runtime = createRuntime({ sessionId: "external-focus" })
  const Screen = defineCapability({
    name: "Screen",
    state: Schema.Number,
    actions: () => ({}),
    onFocus: (state) => state.update((count) => count + 1),
  })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const node = yield* mount(Screen, 0)
        const leave = reportFocus(runtime, node.id)
        yield* Effect.promise(() => runtime.wait({ idle: true }))
        expect(node.getSnapshot()).toBe(1)
        reportFocus(runtime, node.id)
        yield* Effect.promise(() => runtime.wait({ idle: true }))
        expect(node.getSnapshot()).toBe(1)
        leave()
        reportFocus(runtime, node.id)
        yield* Effect.promise(() => runtime.wait({ idle: true }))
        expect(node.getSnapshot()).toBe(2)
      }).pipe(Effect.provideService(Registry, runtime)),
    ),
  )
})
