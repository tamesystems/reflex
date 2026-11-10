import { expect, test } from "bun:test"
import { ErrorCode } from "@reflex/protocol"
import { createRuntime, mountStore } from "@reflex/runtime"
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
    actions: () => ({ Add: { available: true, inputSchema: {} } }),
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
  await expect(first.send("Run")).rejects.toMatchObject({ code: ErrorCode.ActionUnavailable })
  const blurFirst = reportFocus(runtime, first.id)
  expect((await first.send("Run")).status).toBe("completed")
  const blurSecond = reportFocus(runtime, second.id)
  blurFirst()
  expect(runtime.focus).toBe(second.id)
  await expect(first.send("Run")).rejects.toMatchObject({ code: ErrorCode.ActionUnavailable })
  blurSecond()
  expect(runtime.focus).toBeNull()
  first.dispose()
  second.dispose()
})
