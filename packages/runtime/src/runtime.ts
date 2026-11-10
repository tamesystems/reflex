import {
  type ActionDescriptor,
  type AmbientAction,
  assert,
  defined,
  type DispatchParams,
  ErrorCode,
  type EventCursor,
  type InspectParams,
  type InspectResult,
  type Json,
  type NodeId,
  type NodeSnapshot,
  type NodeTarget,
  type NodeType,
  NODES_MAX,
  type OperationId,
  type OperationInfo,
  ownValue,
  PROTOCOL_VERSION,
  ProtocolError,
  RUNNING_OPERATIONS_MAX,
  type RunningOperation,
  type RuntimeEvent,
  type SampleParams,
  SUBSCRIBERS_MAX,
  toNodeId,
  WAIT_NAME_CHARACTERS_MAX,
  WAIT_TIMEOUT_MS_DEFAULT,
  WAIT_TIMEOUT_MS_MAX,
  type WaitParams,
  type WaitResult,
  WAITS_MAX,
} from "@reflex/protocol"
import { EventLog } from "./event-log.ts"
import { matches } from "./matching.ts"
import { type Invocation, OperationTable } from "./operations.ts"
import { type BackgroundReporter, reportToConsole } from "./reporting.ts"
import { systemTimers, type Timers } from "./timers.ts"

/**
 * What a state container must provide to be controlled. The runtime knows
 * nothing about how state is stored: Effect, a reducer, or a Zustand store all
 * fit. Adapters are explicit so that nothing is exposed by accident.
 */
export interface NodeAdapter {
  readonly id: NodeId
  readonly type: NodeType
  readonly name: string
  /** The object UI bindings work with. The runtime only stores it. */
  readonly live?: unknown
  /** Must be JSON, with secrets already removed. */
  snapshot(): Json
  /** Availability may depend on current state. */
  describeActions(): { readonly [name: string]: ActionDescriptor }
  /**
   * Validates `input`, throwing `ProtocolError` if it is unacceptable, and returns
   * what starts the action. Separate, so that an operation can be reported as
   * started only once it will run, and before it does.
   */
  prepare(action: string, input: unknown): () => Invocation
  subscribe(listener: () => void): () => void
  /** Generate a valid wire input, for exploration and agent hints. */
  /** Called once when this node gains focus, after focus is published. */
  onFocus?(): void
  /** Notify local guard subscribers without publishing a state revision. */
  availabilityChanged?(): void
  sample?(action: string, seed: number): Promise<Json>
}

export interface WaitOptions {
  /** Ends the wait with `SessionClosed`, as when its connection goes away. */
  readonly signal?: AbortSignal
}

export type RuntimeListener = (event: RuntimeEvent) => void

export interface Runtime {
  readonly sessionId: string
  readonly focus: NodeId | null
  /** True once `close` has been called. */
  readonly closed: boolean
  /** The newest event's number; a subscriber starting now would resume from it. */
  readonly sequence: number
  /** Handle such as `screen/InventoryDetail/session-1/3`, unique to this session. */
  nextId(type: NodeType, name: string): NodeId
  register(adapter: NodeAdapter): () => void
  setFocus(nodeId: NodeId | null): void
  /** Track work the app starts itself, such as loading on focus. */
  track(nodeId: NodeId, label: string, launch: () => Invocation): Invocation
  inspect(params?: InspectParams): InspectResult
  /** One node's state, without building a whole inspection. */
  stateOf(name: string): Json | undefined
  /** What the node's adapter offered as `live`, for UI bindings. */
  liveOf(nodeId: NodeId): unknown
  dispatch(params: DispatchParams, options?: WaitOptions): Promise<OperationInfo>
  operation(operationId: OperationId): OperationInfo
  cancel(operationId: OperationId): OperationInfo
  wait(params: WaitParams, options?: WaitOptions): Promise<WaitResult>
  sample(params: SampleParams): Promise<Json>
  subscribe(listener: RuntimeListener, options?: { readonly since?: EventCursor }): () => void
  /** For failures with nobody left to tell, such as an observer's. */
  report(error: unknown): void
  /** Stop accepting work and reject pending waits. Call before disposing the app. */
  close(): void
}

export interface RuntimeOptions {
  readonly sessionId: string
  readonly timers?: Timers
  readonly onBackgroundError?: BackgroundReporter
}

export const createRuntime = (options: RuntimeOptions): Runtime =>
  new SessionRuntime(
    options.sessionId,
    options.timers ?? systemTimers,
    options.onBackgroundError ?? reportToConsole,
  )

interface Entry {
  readonly adapter: NodeAdapter
  readonly unsubscribe: () => void
  revision: number
}

interface Waiter {
  check(): void
  abort(error: ProtocolError): void
}

type EventBody = RuntimeEvent extends infer E
  ? E extends RuntimeEvent
    ? Omit<E, "sessionId" | "sequence" | "revision">
    : never
  : never

class SessionRuntime implements Runtime {
  private readonly nodes = new Map<NodeId, Entry>()
  private readonly operations: OperationTable
  private readonly listeners = new Set<RuntimeListener>()
  private readonly log = new EventLog()
  private readonly waiters = new Set<Waiter>()
  private readonly undelivered: Array<RuntimeEvent> = []
  private delivering = false
  private revision = 0
  private lastNodeIndex = 0
  closed = false
  focus: NodeId | null = null
  sequence = 0

  constructor(
    readonly sessionId: string,
    private readonly timers: Timers,
    private readonly reportBackground: BackgroundReporter,
  ) {
    assert(sessionId.length > 0, "a session has an id")
    this.operations = new OperationTable(sessionId, reportBackground)
  }

  report(error: unknown): void {
    this.reportBackground(error)
  }

  nextId(type: NodeType, name: string): NodeId {
    return toNodeId(`${type}/${name}/${this.sessionId}/${++this.lastNodeIndex}`)
  }

  register(adapter: NodeAdapter): () => void {
    assert(!this.nodes.has(adapter.id), `node "${adapter.id}" is registered once`)
    if (this.nodes.size >= NODES_MAX) {
      throw new ProtocolError(ErrorCode.ResourceExhausted, `More than ${NODES_MAX} nodes`)
    }
    const unsubscribe = adapter.subscribe(() => this.onNodeChanged(adapter))
    this.nodes.set(adapter.id, { adapter, unsubscribe, revision: this.revision + 1 })
    this.publishChange({ type: "node.added", nodeId: adapter.id, name: adapter.name })
    return () => this.unregister(adapter.id)
  }

  setFocus(nodeId: NodeId | null): void {
    if (nodeId !== null) {
      this.entry(nodeId)
    }
    if (this.focus !== nodeId) {
      const previous = this.focus
      this.focus = nodeId
      this.publishChange({ type: "focus.changed", nodeId })
      if (previous !== null) {
        this.nodes.get(previous)?.adapter.availabilityChanged?.()
      }
      if (nodeId !== null) {
        this.entry(nodeId).adapter.availabilityChanged?.()
      }
      if (nodeId !== null) {
        this.entry(nodeId).adapter.onFocus?.()
      }
    }
  }

  track(nodeId: NodeId, label: string, launch: () => Invocation): Invocation {
    // Not admitted like dispatch: a node runs one of these at a time, and nodes are capped.
    return this.startOperation({ nodeId, action: label }, launch).invocation
  }

  inspect(params: InspectParams = {}): InspectResult {
    const target = this.findTarget(params)
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      revision: this.revision,
      focus: this.focus,
      node: target === undefined ? null : snapshotOf(target),
      ambient: this.ambientEntries().flatMap(({ adapter }) => ambientActionsOf(adapter)),
      ...(params.tree === true ? { tree: [...this.nodes.values()].map(snapshotOf) } : {}),
    }
  }

  stateOf(name: string): Json | undefined {
    return this.findByName(name)?.adapter.snapshot()
  }

  liveOf(nodeId: NodeId): unknown {
    return this.nodes.get(nodeId)?.adapter.live
  }

  async dispatch(params: DispatchParams, options?: WaitOptions): Promise<OperationInfo> {
    this.requireOpen()
    this.requireSession(params.sessionId)
    const { entry, descriptors } = this.resolveAction(params.action, params.nodeId)
    this.requireRevision(entry, params.expectedRevision)
    this.requireActionable(entry, params.action, descriptors)
    if (this.operations.runningCount >= RUNNING_OPERATIONS_MAX) {
      throw new ProtocolError(ErrorCode.ResourceExhausted, "Too many running operations")
    }
    // Before the action starts: a refusal after it would leave a caller retrying an
    // action that had already run, with no operation to look at.
    if (params.await === true && this.waiters.size >= WAITS_MAX) {
      throw new ProtocolError(ErrorCode.ResourceExhausted, "Too many pending waits")
    }
    const { adapter } = entry
    const launch = adapter.prepare(params.action, params.input)
    const { info } = this.startOperation({ nodeId: adapter.id, action: params.action }, launch)
    return params.await === true ? this.awaitOperation(info, options) : info
  }

  /** A wait, so that it ends with the session or the connection like any other. */
  private async awaitOperation(
    operation: RunningOperation,
    options: WaitOptions | undefined,
  ): Promise<OperationInfo> {
    const { operationId } = operation
    try {
      const params = { operationId, timeoutMs: WAIT_TIMEOUT_MS_MAX }
      const result = await this.wait(params, options)
      return defined(result.operation, "a wait on an operation returns it")
    } catch (error: unknown) {
      // The action is under way, so its id is what the caller needs, to follow it up.
      if (error instanceof ProtocolError && error.code === ErrorCode.WaitTimeout) {
        return operation
      }
      throw error
    }
  }

  operation(operationId: OperationId): OperationInfo {
    return this.operations.lookup(operationId)
  }

  cancel(operationId: OperationId): OperationInfo {
    return this.operations.cancel(operationId)
  }

  async wait(params: WaitParams, options?: WaitOptions): Promise<WaitResult> {
    this.requireOpen()
    for (const name of [params.name, params.focus]) {
      if (name !== undefined && name.length > WAIT_NAME_CHARACTERS_MAX) {
        throw new ProtocolError(ErrorCode.ResourceExhausted, "Wait name or focus is too long")
      }
    }
    // An abort before this point fires no event, so it has to be looked for.
    if (options?.signal?.aborted === true) {
      throw this.closedError()
    }
    if (this.isSatisfied(params)) {
      return this.waitResult(params)
    }
    if (this.waiters.size >= WAITS_MAX) {
      throw new ProtocolError(ErrorCode.ResourceExhausted, "Too many pending waits")
    }
    return this.suspend(params, options?.signal)
  }

  async sample(params: SampleParams): Promise<Json> {
    const { entry, descriptors } = this.resolveAction(params.action, params.nodeId)
    const { adapter } = entry
    if (ownValue(descriptors, params.action) === undefined) {
      throw new ProtocolError(
        ErrorCode.ActionNotFound,
        `"${adapter.name}" has no action "${params.action}"`,
      )
    }
    if (adapter.sample === undefined) {
      throw new ProtocolError(ErrorCode.Unsupported, `"${adapter.name}" cannot generate inputs`)
    }
    return adapter.sample(params.action, params.seed ?? 0)
  }

  subscribe(listener: RuntimeListener, options?: { readonly since?: EventCursor }): () => void {
    if (this.listeners.size >= SUBSCRIBERS_MAX) {
      throw new ProtocolError(ErrorCode.ResourceExhausted, "Too many subscribers")
    }
    if (options?.since !== undefined) {
      this.replay(listener, options.since)
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const waiter of [...this.waiters]) {
      waiter.abort(this.closedError())
    }
  }

  private replay(listener: RuntimeListener, since: EventCursor): void {
    const { sequence: latestSequence } = this
    const events =
      since.sessionId === this.sessionId
        ? this.log.after({ sequence: since.sequence, latestSequence })
        : null
    if (events === null) {
      const { sessionId, sequence, revision } = this
      this.deliver(listener, { type: "resync.required", sessionId, sequence, revision })
      return
    }
    for (const event of events) {
      this.deliver(listener, event)
    }
  }

  private suspend(params: WaitParams, signal: AbortSignal | undefined): Promise<WaitResult> {
    const timeoutMs = params.timeoutMs ?? WAIT_TIMEOUT_MS_DEFAULT
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.waiters.delete(waiter)
        this.timers.clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      const waiter: Waiter = {
        check: () => {
          try {
            if (this.isSatisfied(params)) {
              finish()
              resolve(this.waitResult(params))
            }
          } catch (error: unknown) {
            finish()
            reject(error)
          }
        },
        abort: (error) => {
          finish()
          reject(error)
        },
      }
      const onAbort = () => waiter.abort(this.closedError())
      const timer = this.timers.setTimeout(() => {
        finish()
        reject(this.timeoutError(params, timeoutMs))
      }, timeoutMs)
      this.waiters.add(waiter)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private timeoutError(params: WaitParams, timeoutMs: number): ProtocolError {
    const message = `Condition not met within ${timeoutMs}ms`
    try {
      const target = this.findTarget(params)
      return new ProtocolError(ErrorCode.WaitTimeout, message, {
        focus: this.focus,
        runningOperationCount: this.operations.runningCount,
        state: target === undefined ? null : target.adapter.snapshot(),
      })
    } catch {
      // The timeout is what must be reported. Its context is only a courtesy,
      // and a target that has gone or cannot be read must not leave it unsettled.
      return new ProtocolError(ErrorCode.WaitTimeout, message)
    }
  }

  private isSatisfied(params: WaitParams): boolean {
    if (!this.targetExists(params)) {
      return false
    }
    if (params.focus !== undefined && !this.isFocused(params.focus)) {
      return false
    }
    if (params.match !== undefined && !this.targetMatches(params, params.match)) {
      return false
    }
    if (params.operationId !== undefined) {
      if (this.operations.lookup(params.operationId).status === "running") {
        return false
      }
    }
    if (params.idle === true) {
      return this.operations.runningCount === 0
    }
    return true
  }

  /** Naming a node is a condition in itself: that it exists. */
  private targetExists(target: NodeTarget): boolean {
    if (target.nodeId === undefined && target.name === undefined) {
      return true
    }
    return this.findLiveTarget(target) !== undefined
  }

  private isFocused(name: string): boolean {
    if (this.focus === null) {
      return false
    }
    return this.nodes.get(this.focus)?.adapter.name === name
  }

  private targetMatches(target: NodeTarget, expected: Json): boolean {
    const entry = this.findLiveTarget(target)
    if (entry === undefined) {
      return false
    }
    return matches(entry.adapter.snapshot(), expected)
  }

  private waitResult(params: WaitParams): WaitResult {
    const { revision, sequence } = this
    if (params.operationId === undefined) {
      return { revision, sequence }
    }
    return { revision, sequence, operation: this.operations.lookup(params.operationId) }
  }

  private startOperation(
    target: { readonly nodeId: NodeId; readonly action: string },
    launch: () => Invocation,
  ) {
    return this.operations.start(target, launch, {
      onStarted: (operation) => this.publishNotice({ type: "operation.started", operation }),
      onSettled: (operation) => this.publishNotice({ type: "operation.finished", operation }),
    })
  }

  private resolveAction(action: string, nodeId: NodeId | undefined) {
    const entry = nodeId === undefined ? this.findActionOwner(action) : this.entry(nodeId)
    return { entry, descriptors: entry.adapter.describeActions() }
  }

  private findActionOwner(action: string): Entry {
    const focused = this.focus === null ? undefined : this.nodes.get(this.focus)
    if (focused !== undefined && Object.hasOwn(focused.adapter.describeActions(), action)) {
      return focused
    }
    const ambient = this.ambientEntries()
    const owners = ambient.filter(({ adapter }) => Object.hasOwn(adapter.describeActions(), action))
    const [owner, ...others] = owners
    if (owner === undefined) {
      const reachable = focused === undefined ? ambient : [focused, ...ambient]
      throw new ProtocolError(ErrorCode.ActionNotFound, `Nothing here accepts "${action}"`, {
        focus: this.focus,
        available: reachable.flatMap(({ adapter }) => Object.keys(adapter.describeActions())),
      })
    }
    if (others.length > 0) {
      throw new ProtocolError(
        ErrorCode.AmbiguousAction,
        `"${action}" exists on several nodes; pass nodeId`,
        { nodes: owners.map(({ adapter }) => adapter.id) },
      )
    }
    return owner
  }

  private requireActionable(
    { adapter }: Entry,
    action: string,
    descriptors: { readonly [name: string]: ActionDescriptor },
  ): void {
    if (adapter.type === "screen" && adapter.id !== this.focus) {
      throw new ProtocolError(ErrorCode.ActionUnavailable, `"${adapter.id}" is not focused`)
    }
    const descriptor = ownValue(descriptors, action)
    if (descriptor === undefined) {
      throw new ProtocolError(
        ErrorCode.ActionNotFound,
        `"${adapter.name}" has no action "${action}"`,
        { available: Object.keys(descriptors) },
      )
    }
    if (!descriptor.available) {
      throw new ProtocolError(ErrorCode.ActionUnavailable, descriptor.unavailableReason)
    }
  }

  private requireRevision(entry: Entry, expected: number | undefined): void {
    if (expected !== undefined && expected !== entry.revision) {
      throw new ProtocolError(
        ErrorCode.StaleRevision,
        `"${entry.adapter.id}" is at revision ${entry.revision}, not ${expected}`,
        { revision: entry.revision },
      )
    }
  }

  private requireSession(expected: string | undefined): void {
    if (expected !== undefined && expected !== this.sessionId) {
      throw new ProtocolError(
        ErrorCode.StaleSession,
        `Session is "${this.sessionId}", not "${expected}"`,
        { sessionId: this.sessionId },
      )
    }
  }

  private requireOpen(): void {
    if (this.closed) {
      throw this.closedError()
    }
  }

  private closedError(): ProtocolError {
    return new ProtocolError(ErrorCode.SessionClosed, `Session "${this.sessionId}" has ended`)
  }

  /** For inspection, where a node that was named but is missing is an error. */
  private findTarget(target: NodeTarget): Entry | undefined {
    const entry = this.findLiveTarget(target)
    if (entry !== undefined) {
      return entry
    }
    if (target.nodeId !== undefined) {
      throw new ProtocolError(ErrorCode.NodeNotFound, `No active node "${target.nodeId}"`)
    }
    if (target.name !== undefined) {
      throw new ProtocolError(ErrorCode.NodeNotFound, `No active node named "${target.name}"`)
    }
    return undefined
  }

  /** For waits, where a target that does not exist yet is simply not satisfied. */
  private findLiveTarget(target: NodeTarget): Entry | undefined {
    if (target.nodeId !== undefined) {
      return this.nodes.get(target.nodeId)
    }
    if (target.name !== undefined) {
      return this.findByName(target.name)
    }
    return this.focus === null ? undefined : this.nodes.get(this.focus)
  }

  /** Two screens of one capability share a name: picking one would be a guess. */
  private findByName(name: string): Entry | undefined {
    const [found, ...others] = [...this.nodes.values()].filter(
      ({ adapter }) => adapter.name === name,
    )
    if (others.length > 0) {
      throw new ProtocolError(
        ErrorCode.AmbiguousName,
        `Several nodes are named "${name}"; pass nodeId`,
        { nodes: [found, ...others].flatMap((entry) => (entry ? [entry.adapter.id] : [])) },
      )
    }
    return found
  }

  private entry(nodeId: NodeId): Entry {
    const found = this.nodes.get(nodeId)
    if (found === undefined) {
      throw new ProtocolError(ErrorCode.NodeNotFound, `No active node "${nodeId}"`)
    }
    return found
  }

  private ambientEntries(): ReadonlyArray<Entry> {
    return [...this.nodes.values()].filter(({ adapter }) => adapter.type !== "screen")
  }

  private onNodeChanged(adapter: NodeAdapter): void {
    const entry = this.nodes.get(adapter.id)
    if (entry !== undefined) {
      const state = adapter.snapshot()
      entry.revision = this.revision + 1
      this.publishChange({ type: "state.changed", nodeId: adapter.id, state })
    }
  }

  private unregister(nodeId: NodeId): void {
    const entry = this.nodes.get(nodeId)
    if (entry === undefined) {
      return
    }
    this.nodes.delete(nodeId)
    entry.unsubscribe()
    if (this.focus === nodeId) {
      this.setFocus(null)
    }
    this.publishChange({ type: "node.removed", nodeId })
  }

  /** An observer's failure is its own: application work must not fail because of it. */
  private deliver(listener: RuntimeListener, event: RuntimeEvent): void {
    try {
      listener(event)
    } catch (error: unknown) {
      this.reportBackground(error)
    }
  }

  /** Something observable changed, so observations before this are stale. */
  private publishChange(body: EventBody): void {
    this.revision++
    this.publishNotice(body)
  }

  private publishNotice(body: EventBody): void {
    this.sequence++
    const { sessionId, sequence, revision } = this
    // The body is one member of the union and the fields added are the ones omitted.
    const event = { ...body, sessionId, sequence, revision } as RuntimeEvent
    this.log.append(event)
    this.undelivered.push(event)
    this.deliverInOrder()
  }

  /**
   * An observer may cause another event. That one must wait its turn, or observers
   * after it would see the two in the wrong order.
   */
  private deliverInOrder(): void {
    if (this.delivering) {
      return
    }
    this.delivering = true
    try {
      for (let index = 0; index < this.undelivered.length; index++) {
        const event = defined(this.undelivered[index], "index is within the list")
        for (const listener of this.listeners) {
          this.deliver(listener, event)
        }
        for (const waiter of [...this.waiters]) {
          waiter.check()
        }
      }
    } finally {
      this.undelivered.length = 0
      this.delivering = false
    }
  }
}

const snapshotOf = ({ adapter, revision }: Entry): NodeSnapshot => ({
  id: adapter.id,
  type: adapter.type,
  name: adapter.name,
  revision,
  state: adapter.snapshot(),
  actions: adapter.describeActions(),
})

const ambientActionsOf = (adapter: NodeAdapter): ReadonlyArray<AmbientAction> =>
  Object.entries(adapter.describeActions()).map(([action, descriptor]) => ({
    ...descriptor,
    nodeId: adapter.id,
    nodeType: adapter.type,
    action,
  }))
