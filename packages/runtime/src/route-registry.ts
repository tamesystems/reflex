import { ROUTER_RETAINED_ENTRIES_MAX, ROUTE_BUILD_TIMEOUT_MS } from "@reflex/protocol"
import { systemTimers, withDeadline, type Timers } from "./timers.ts"
import { reportToConsole, type BackgroundReporter } from "./reporting.ts"

export type RouteSnapshot<T> =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "error"; readonly error: Error }
export interface RouteLease<T> {
  readonly ready: Promise<T>
  getSnapshot(): RouteSnapshot<T>
  subscribe(listener: () => void): () => void
  retain(): () => void
  retry(): Promise<T>
}
type Factory<T> = (params: unknown, signal: AbortSignal) => T | Promise<T>
const disposeValue = async <T>(value: T) => {
  if (value !== null && typeof value === "object" && "dispose" in value) {
    await (value as { dispose(): unknown }).dispose()
  }
}
class Entry<T> implements RouteLease<T> {
  private snapshot: RouteSnapshot<T> = { status: "pending" }
  private disposed = false
  private generation = 0
  private abort = new AbortController()
  private readonly listeners = new Set<() => void>()
  ready: Promise<T>
  users = 0
  retained = false
  constructor(
    readonly contract: object,
    readonly paramsKey: string | undefined,
    private readonly mount: (signal: AbortSignal) => T | Promise<T>,
    private readonly timers: Timers,
    private readonly release: () => void,
    private readonly reserveBuild: (entry: Entry<T>) => () => void,
  ) {
    this.ready = this.start()
  }
  readonly getSnapshot = () => this.snapshot
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(snapshot: RouteSnapshot<T>) {
    this.snapshot = snapshot
    for (const listener of this.listeners) {
      listener()
    }
  }
  private start(): Promise<T> {
    const run = ++this.generation
    this.publish({ status: "pending" })
    const abort = new AbortController()
    this.abort = abort
    const cancelled = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true })
    })
    let releaseBuild: () => void = () => undefined
    const work = Promise.resolve()
      .then(() => {
        if (abort.signal.aborted) {
          throw abort.signal.reason
        }
        releaseBuild = this.reserveBuild(this)
        return this.mount(abort.signal)
      })
      .then(async (value) => {
        if (this.disposed || run !== this.generation || abort.signal.aborted) {
          await disposeValue(value)
        }
        return value
      })
      .finally(() => releaseBuild())
    const promise = withDeadline(Promise.race([work, cancelled]), {
      timers: this.timers,
      timeoutMs: ROUTE_BUILD_TIMEOUT_MS,
      overdue: () => {
        const error = new Error("Route build timed out")
        abort.abort(error)
        return error
      },
    }).then(
      (value) => {
        if (!this.disposed && run === this.generation) {
          this.publish({ status: "ready", value })
        }
        return value
      },
      (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        if (!this.disposed && run === this.generation) {
          this.publish({ status: "error", error })
        }
        throw error
      },
    )
    // Status hooks observe errors through the snapshot; abandoned renders have no waiter.
    void promise.catch(() => undefined)
    return promise
  }
  retain() {
    if (this.disposed) {
      throw new Error("The route entry is disposed")
    }
    this.users++
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.users--
      queueMicrotask(() => {
        if (this.users === 0 && !this.retained) {
          this.release()
        }
      })
    }
  }
  retry(): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("The route entry is disposed"))
    }
    const previous = this.snapshot
    // Publish pending synchronously, so a second retry reuses this generation.
    if (previous.status === "pending") {
      return this.ready
    }
    const old = previous.status === "ready" ? previous.value : null
    this.ready = this.startAfterDisposal(old)
    return this.ready
  }
  private startAfterDisposal(old: T | null): Promise<T> {
    this.publish({ status: "pending" })
    const promise = Promise.resolve(old === null ? undefined : disposeValue(old)).then(() =>
      this.start(),
    )
    void promise.catch(() => undefined)
    return promise
  }
  async dispose() {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.abort.abort(new Error("The route entry is disposed"))
    this.listeners.clear()
    if (this.snapshot.status === "ready") {
      await disposeValue(this.snapshot.value)
    }
  }
}
/** One session owner for render resources, committed views and bounded history. */
export class RouteRegistry<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly pendingBuilds = new Map<Entry<T>, number>()
  private keys: string[] = []
  private index = -1
  private closed = false
  constructor(
    private readonly factories: ReadonlyMap<object, Factory<T>>,
    private readonly report: BackgroundReporter,
    private readonly timers: Timers,
  ) {}
  get size() {
    return this.entries.size
  }
  async discard(key: string) {
    const entry = this.entries.get(key)
    this.entries.delete(key)
    await entry?.dispose()
  }
  private forget(key: string) {
    void this.discard(key).catch(this.report)
  }
  private footprint() {
    let size = this.entries.size
    for (const [entry, count] of this.pendingBuilds) {
      size += count
      if ([...this.entries.values()].includes(entry)) {
        size--
      }
    }
    return size
  }
  private reserveBuild(entry: Entry<T>) {
    const ownsSlot = [...this.entries.values()].includes(entry) && !this.pendingBuilds.has(entry)
    if (!ownsSlot && this.footprint() >= ROUTER_RETAINED_ENTRIES_MAX) {
      throw new Error("Too many route builds are still pending")
    }
    this.pendingBuilds.set(entry, (this.pendingBuilds.get(entry) ?? 0) + 1)
    return () => {
      const count = (this.pendingBuilds.get(entry) ?? 1) - 1
      if (count === 0) {
        this.pendingBuilds.delete(entry)
      } else {
        this.pendingBuilds.set(entry, count)
      }
    }
  }
  private trim() {
    for (const [key, entry] of this.entries) {
      if (this.footprint() < ROUTER_RETAINED_ENTRIES_MAX) {
        break
      }
      if (entry.users === 0) {
        this.forget(key)
      }
    }
    if (this.footprint() >= ROUTER_RETAINED_ENTRIES_MAX) {
      throw new Error("Too many active route entries")
    }
  }
  acquire(contract: object, key: string, params: unknown): RouteLease<T> {
    if (this.closed) {
      throw new Error("The route registry is disposed")
    }
    const current = this.entries.get(key)
    if (current) {
      if (current.contract !== contract) {
        throw new Error(`History entry "${key}" already owns another definition`)
      }
      if (current.paramsKey !== JSON.stringify(params)) {
        throw new Error(`History entry "${key}" has conflicting params`)
      }
      return current
    }
    const factory = this.factories.get(contract)
    if (!factory) {
      throw new Error("The route definition is not registered in this session's app")
    }
    this.trim()
    const entry = new Entry(
      contract,
      JSON.stringify(params),
      (signal) => factory(params, signal),
      this.timers,
      () => {
        if (this.entries.get(key) === entry) {
          this.forget(key)
        }
      },
      (entry) => this.reserveBuild(entry),
    )
    this.entries.set(key, entry)
    return entry
  }
  private releaseHistory(key: string) {
    const entry = this.entries.get(key)
    if (entry) {
      entry.retained = false
      if (entry.users === 0) {
        this.forget(key)
      }
    }
  }
  visit(key: string, kind: "POP" | "PUSH" | "REPLACE") {
    const entry = this.entries.get(key)
    if (entry) {
      entry.retained = true
    }
    const existing = this.keys.indexOf(key)
    if (existing >= 0) {
      this.index = existing
      return
    }
    const obsolete =
      kind === "REPLACE"
        ? this.keys.splice(Math.max(0, this.index))
        : this.keys.splice(this.index + 1)
    for (const old of obsolete) {
      this.releaseHistory(old)
    }
    this.keys.push(key)
    if (this.keys.length > ROUTER_RETAINED_ENTRIES_MAX) {
      const old = this.keys.shift()
      if (old !== undefined) {
        this.releaseHistory(old)
      }
    }
    this.index = this.keys.length - 1
  }
  async dispose() {
    this.closed = true
    this.keys = []
    await Promise.all([...this.entries.keys()].map((key) => this.discard(key)))
  }
}
export const createRouteRegistry = <T>(
  factories: ReadonlyMap<object, Factory<T>>,
  report: BackgroundReporter = reportToConsole,
  timers: Timers = systemTimers,
) => new RouteRegistry(factories, report, timers)
