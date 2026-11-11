import { expect, test } from "bun:test"
import { defined, ErrorCode } from "@reflex/protocol"
import { createRuntime, defineStoreNode } from "@reflex/runtime/internal"
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
    defineStoreNode({
      name,
      type: "screen",
      store: () => store,
      project: (s) => s,
      actions: (action) => ({ Run: action({ handler: () => undefined }) }),
    }).mount(runtime)
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
  const { Screen, defineApp } = await import("@reflex/effect")
  const { APP_HOST_ADAPTER, mountSessionRoute } = await import("@reflex/runtime/internal")
  const Schema = await import("effect/Schema")
  const Contract = Screen("Screen", { state: Schema.Number, initial: () => 0 })
  const definition = Contract.implement({
    actions: () => ({}),
    onFocus: ({ state }) => state.update((count) => count + 1),
  })
  const app = defineApp({ name: "external-focus", screens: [definition] })
  const host = (
    app as unknown as { readonly [APP_HOST_ADAPTER]: import("@reflex/runtime/internal").AppHost }
  )[APP_HOST_ADAPTER]
  const session = await defined(host, "Effect descriptor carries its infrastructure host").start(
    "default",
    { sessionId: "external-focus" },
  )
  const { runtime } = session
  try {
    const node = await mountSessionRoute(runtime, definition, {})
    const leave = reportFocus(runtime, node.id)
    await runtime.wait({ idle: true })
    expect(runtime.inspect({ nodeId: node.id }).node?.state).toBe(1)
    reportFocus(runtime, node.id)
    await runtime.wait({ idle: true })
    expect(runtime.inspect({ nodeId: node.id }).node?.state).toBe(1)
    leave()
    reportFocus(runtime, node.id)
    await runtime.wait({ idle: true })
    expect(runtime.inspect({ nodeId: node.id }).node?.state).toBe(2)
  } finally {
    runtime.close()
    await session.dispose()
  }
})
