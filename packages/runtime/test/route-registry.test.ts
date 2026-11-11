import { expect, test } from "bun:test"
import { ROUTER_RETAINED_ENTRIES_MAX } from "@reflex/protocol"
import { createRouteRegistry } from "../src/route-registry.ts"

test("status and Suspense share a pending build and dispose it once", async () => {
  const contract = {}
  let mounts = 0
  let disposals = 0
  let finish!: (node: { dispose(): void }) => void
  const registry = createRouteRegistry(
    new Map([
      [
        contract,
        () => {
          mounts++
          return new Promise<{ dispose(): void }>((resolve) => {
            finish = resolve
          })
        },
      ],
    ]),
  )
  const normal = registry.acquire(contract, "entry", {})
  const suspense = registry.acquire(contract, "entry", {})
  expect(normal).toBe(suspense)
  const release = normal.retain()
  await Promise.resolve()
  expect(mounts).toBe(1)
  finish({
    dispose: () => {
      disposals++
    },
  })
  await suspense.ready
  expect(normal.getSnapshot().status).toBe("ready")
  release()
  await Promise.resolve()
  expect(registry.size).toBe(0)
  await registry.dispose()
  expect(disposals).toBe(1)
})

test("retry replaces a rejected promise in the same lease", async () => {
  const contract = {}
  let attempts = 0
  const registry = createRouteRegistry(
    new Map([
      [
        contract,
        async () => {
          if (++attempts === 1) {
            throw new Error("first build failed")
          }
          return { attempt: attempts }
        },
      ],
    ]),
  )
  const lease = registry.acquire(contract, "entry", {})
  const rejected = lease.ready
  await expect(rejected).rejects.toThrow("first build failed")
  expect(lease.getSnapshot().status).toBe("error")
  await lease.retry()
  expect(lease.ready).not.toBe(rejected)
  expect(lease.getSnapshot()).toEqual({ status: "ready", value: { attempt: 2 } })
  expect(registry.acquire(contract, "entry", {})).toBe(lease)
  await registry.dispose()
})

test("reset disposes late results and releases all entries", async () => {
  const contract = {}
  let finish!: (node: { dispose(): void }) => void
  let disposals = 0
  const registry = createRouteRegistry(
    new Map([
      [
        contract,
        () =>
          new Promise<{ dispose(): void }>((resolve) => {
            finish = resolve
          }),
      ],
    ]),
  )
  const lease = registry.acquire(contract, "pending", {})
  await Promise.resolve()
  await registry.dispose()
  expect(registry.size).toBe(0)
  finish({
    dispose: () => {
      disposals++
    },
  })
  await expect(lease.ready).rejects.toThrow("disposed")
  await Promise.resolve()
  expect(disposals).toBe(1)
  expect(() => registry.acquire(contract, "new", {})).toThrow("disposed")
})

test("history has bounded retention, releases forward entries and remounts evictions", async () => {
  const contract = {}
  let disposals = 0
  const registry = createRouteRegistry(
    new Map([
      [
        contract,
        () => ({
          dispose: () => {
            disposals++
          },
        }),
      ],
    ]),
  )
  const visit = async (key: string, kind: "POP" | "PUSH" | "REPLACE" = "PUSH") => {
    const lease = registry.acquire(contract, key, {})
    const release = lease.retain()
    registry.visit(key, kind)
    await lease.ready
    release()
    return lease
  }
  const first = await visit("first")
  await visit("second")
  await visit("first", "POP")
  await visit("replacement")
  expect(disposals).toBe(1)
  for (let i = 0; i < ROUTER_RETAINED_ENTRIES_MAX; i++) {
    await visit(`entry-${i}`)
  }
  expect(registry.size).toBe(ROUTER_RETAINED_ENTRIES_MAX)
  expect(registry.acquire(contract, "first", {})).not.toBe(first)
  await registry.dispose()
  expect(registry.size).toBe(0)
})

test("a history entry rejects conflicting contracts", async () => {
  const a = {}
  const b = {}
  const registry = createRouteRegistry(
    new Map([
      [a, () => ({})],
      [b, () => ({})],
    ]),
  )
  registry.acquire(a, "entry", {})
  expect(() => registry.acquire(b, "entry", {})).toThrow("another definition")
  await registry.dispose()
})

test("a history entry refuses conflicting params", async () => {
  const contract = {}
  const registry = createRouteRegistry(new Map([[contract, () => ({})]]))
  registry.acquire(contract, "entry", { id: "one" })
  expect(() => registry.acquire(contract, "entry", { id: "two" })).toThrow("conflicting params")
  await registry.dispose()
})

test("a pending route has a deadline, aborts, retries and disposes its late result", async () => {
  const contract = {}
  const deadlines = new Map<object, () => void>()
  let signal: AbortSignal | undefined
  let finish!: (node: { dispose(): void }) => void
  let attempts = 0
  let disposed = 0
  const registry = createRouteRegistry(
    new Map([
      [
        contract,
        (_params: unknown, abort: AbortSignal) => {
          signal = abort
          if (++attempts > 1) {
            return Promise.resolve({
              dispose() {
                disposed++
              },
            })
          }
          return new Promise<{ dispose(): void }>((resolve) => {
            finish = resolve
          })
        },
      ],
    ]),
    () => undefined,
    {
      setTimeout: (callback, duration) => {
        expect(duration).toBe(30_000)
        const handle = {}
        deadlines.set(handle, callback)
        return handle
      },
      clearTimeout: (handle) => {
        deadlines.delete(handle as object)
      },
    },
  )
  const lease = registry.acquire(contract, "entry", {})
  await Promise.resolve()
  for (const expire of deadlines.values()) {
    expire()
  }
  await expect(lease.ready).rejects.toThrow("timed out")
  expect(signal?.aborted).toBe(true)
  await lease.retry()
  finish({
    dispose() {
      disposed++
    },
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(disposed).toBe(1)
  await registry.dispose()
  expect(disposed).toBe(2)
  expect(deadlines.size).toBe(0)
})

test("discarded abort-ignoring builds keep their capacity until they settle", async () => {
  const contract = {}
  const finishes: Array<(value: object) => void> = []
  const registry = createRouteRegistry(
    new Map([
      [
        contract,
        () =>
          new Promise<object>((resolve) => {
            finishes.push(resolve)
          }),
      ],
    ]),
  )
  const leases = Array.from({ length: ROUTER_RETAINED_ENTRIES_MAX }, (_, i) =>
    registry.acquire(contract, String(i), {}),
  )
  await Promise.resolve()
  for (let i = 0; i < leases.length; i++) {
    await registry.discard(String(i))
  }
  expect(registry.size).toBe(0)
  expect(() => registry.acquire(contract, "next", {})).toThrow("Too many active")
  for (const finish of finishes) {
    finish({})
  }
  await Promise.allSettled(leases.map((lease) => lease.ready))
  // The underlying work's finally releases its slot after the cancelled public lease.
  await Promise.resolve()
  await Promise.resolve()
  const next = registry.acquire(contract, "next", {})
  await registry.discard("next")
  await expect(next.ready).rejects.toThrow("disposed")
  await registry.dispose()
})
