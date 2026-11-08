import {
  type AccessPolicy,
  assert,
  type DescribeResult,
  ErrorCode,
  type EventCursor,
  LIFECYCLE_QUEUE_MAX,
  type Method,
  type Methods,
  PROTOCOL_VERSION,
  ProtocolError,
  type RuntimeEvent,
  type ScenarioDescriptor,
  UNFINISHED_SESSIONS_MAX,
} from "@reflex/protocol"
import { createControlWork } from "./control-work.ts"
import { type BackgroundReporter, reportToConsole } from "./reporting.ts"
import type { Runtime } from "./runtime.ts"
import {
  awaitSession,
  endSession,
  type SessionLifecycleOptions,
  startCounted,
} from "./session-lifecycle.ts"
import { systemTimers, type Timers } from "./timers.ts"

/** A running instance of an application. */
export interface AppSession {
  readonly runtime: Runtime
  /** Present only when the session runs on virtual time. */
  advanceTime?(durationMs: number): Promise<number>
  dispose(): Promise<void>
}

export interface SessionStartOptions {
  readonly sessionId: string
  /** Where the session's own failures with nobody to tell should go. */
  readonly onBackgroundError?: BackgroundReporter
}

/** Something that can start sessions: the seam between protocol and app. */
export interface AppHost {
  readonly name: string
  readonly scenarios: ReadonlyArray<ScenarioDescriptor>
  readonly defaultScenario: string
  start(scenario: string, options: SessionStartOptions): Promise<AppSession>
}

export type ControllerMethod = Exclude<
  Method,
  "app.subscribe" | "app.unsubscribe" | "session.shutdown"
>

export interface ControllerSubscription {
  readonly unsubscribe: () => void
  readonly sessionId: string
  readonly sequence: number
}

export interface Controller {
  request<M extends ControllerMethod>(
    method: M,
    params: Methods[M]["params"],
    options?: { readonly signal?: AbortSignal },
  ): Promise<Methods[M]["result"]>
  /**
   * Waits out any reset in progress, then survives later ones: a reset arrives
   * as `resync.required` on the new session.
   */
  subscribe(
    listener: (event: RuntimeEvent) => void,
    options?: { readonly since?: EventCursor },
  ): Promise<ControllerSubscription>
  close(): Promise<void>
  /**
   * The policy this controller holds its peers to, if less than full control. Whatever
   * serves it applies this to the methods it handles itself, such as `session.shutdown`.
   */
  readonly access?: AccessPolicy
}

export interface ControllerOptions {
  readonly scenario?: string
  /** Distinguishes this process's sessions from those of an earlier one. */
  readonly sessionPrefix?: string
  readonly startTimeoutMs?: number
  readonly disposeTimeoutMs?: number
  /** Failures with nobody left to tell, such as a late session's disposal. */
  readonly onBackgroundError?: BackgroundReporter
  readonly timers?: Timers
}

export const createController = async (
  host: AppHost,
  options: ControllerOptions = {},
): Promise<Controller> => {
  const controller = new SessionController(host, options)
  await controller.start()
  return controller
}

type Phase =
  | { readonly kind: "starting" }
  | { readonly kind: "running"; readonly session: AppSession }
  | { readonly kind: "resetting" }
  /** A reset failed to start its replacement; another reset can recover. */
  | { readonly kind: "failed" }
  | { readonly kind: "closed"; readonly finished: Promise<void> }

type Handlers = {
  readonly [M in ControllerMethod]: (
    params: Methods[M]["params"],
    signal: AbortSignal | undefined,
  ) => Promise<Methods[M]["result"]> | Methods[M]["result"]
}

class SessionController implements Controller {
  private phase: Phase = { kind: "starting" }
  private scenario: string
  private lastEpoch = 0
  /** Resets and close run strictly one at a time, in the order requested. */
  private lifecycle: Promise<unknown> = Promise.resolve()
  private queuedCount = 0
  /** From the start of a start to the end of its disposal, however long that takes. */
  private unfinishedSessionCount = 0
  private abortStart: ((error: ProtocolError) => void) | undefined
  private readonly subscribers = new Map<(event: RuntimeEvent) => void, () => void>()
  private readonly timers: Timers
  private readonly report: BackgroundReporter
  private readonly withinControlDeadline: ReturnType<typeof createControlWork>

  constructor(
    private readonly host: AppHost,
    private readonly options: ControllerOptions,
  ) {
    this.timers = options.timers ?? systemTimers
    this.report = options.onBackgroundError ?? reportToConsole
    this.withinControlDeadline = createControlWork(this.timers, this.report)
    this.scenario = this.requireScenario(options.scenario ?? host.defaultScenario)
  }

  private readonly handlers: Handlers = {
    "app.describe": () => this.describe(),
    "app.inspect": (params) => this.session().runtime.inspect(params),
    "app.dispatch": (params, signal) =>
      this.session().runtime.dispatch(params, signal === undefined ? {} : { signal }),
    "app.operation": ({ operationId }) => this.session().runtime.operation(operationId),
    "app.cancel": ({ operationId }) => this.session().runtime.cancel(operationId),
    "app.wait": (params, signal) =>
      this.session().runtime.wait(params, signal === undefined ? {} : { signal }),
    "app.reset": (params) => this.enqueue(() => this.reset(params.scenario)),
    "app.advanceTime": ({ durationMs }) => this.advanceTime(durationMs),
    "app.sample": async (params) => ({
      input: await this.withinControlDeadline(() => this.session().runtime.sample(params)),
    }),
  }

  async start(): Promise<void> {
    this.phase = { kind: "running", session: await this.startSession(this.scenario) }
  }

  async request<M extends ControllerMethod>(
    method: M,
    params: Methods[M]["params"],
    options?: { readonly signal?: AbortSignal },
  ): Promise<Methods[M]["result"]> {
    // Land on the session that exists once any reset in progress has finished.
    if (method !== "app.reset") {
      await this.lifecycle
    }
    const handler: Handlers[M] = this.handlers[method]
    return handler(params, options?.signal)
  }

  async subscribe(
    listener: (event: RuntimeEvent) => void,
    options?: { readonly since?: EventCursor },
  ): Promise<ControllerSubscription> {
    await this.lifecycle
    const { runtime } = this.session()
    const stop = runtime.subscribe(listener, options?.since ? { since: options.since } : {})
    this.subscribers.set(listener, stop)
    return {
      unsubscribe: () => {
        this.subscribers.get(listener)?.()
        this.subscribers.delete(listener)
      },
      sessionId: runtime.sessionId,
      sequence: runtime.sequence,
    }
  }

  close(): Promise<void> {
    const phase = this.phase
    if (phase.kind === "closed") {
      return phase.finished
    }
    const finished = this.lifecycle.then(async () => {
      for (const stop of this.subscribers.values()) {
        stop()
      }
      this.subscribers.clear()
      if (phase.kind === "running") {
        await endSession(phase.session, this.lifecycleOptions())
      }
    })
    this.phase = { kind: "closed", finished }
    this.abortStart?.(this.closedError())
    return finished
  }

  private lifecycleOptions(): SessionLifecycleOptions {
    const { startTimeoutMs, disposeTimeoutMs } = this.options
    return {
      timers: this.timers,
      onBackgroundError: this.report,
      ...(startTimeoutMs === undefined ? {} : { startTimeoutMs }),
      ...(disposeTimeoutMs === undefined ? {} : { disposeTimeoutMs }),
    }
  }

  private describe(): DescribeResult {
    const { runtime, advanceTime } = this.session()
    return {
      protocolVersion: PROTOCOL_VERSION,
      app: this.host.name,
      sessionId: runtime.sessionId,
      scenario: this.scenario,
      scenarios: this.host.scenarios,
      capabilities: { virtualTime: advanceTime !== undefined },
    }
  }

  private async advanceTime(durationMs: number): Promise<{ readonly nowVirtualMs: number }> {
    const { advanceTime } = this.session()
    if (advanceTime === undefined) {
      throw new ProtocolError(
        ErrorCode.Unsupported,
        `Scenario "${this.scenario}" runs on real time`,
      )
    }
    const nowVirtualMs = await this.withinControlDeadline(() => advanceTime(durationMs))
    return { nowVirtualMs }
  }

  private async reset(requested: string | undefined): Promise<DescribeResult> {
    const phase = this.phase
    if (phase.kind === "closed") {
      throw this.closedError()
    }
    const scenario = this.requireScenario(requested ?? this.scenario)
    this.phase = { kind: "resetting" }
    let previousSessionId = ""
    try {
      if (phase.kind === "running") {
        previousSessionId = phase.session.runtime.sessionId
        await endSession(phase.session, this.lifecycleOptions())
      }
      this.requireNotClosed()
      const session = await this.startSession(scenario)
      if (this.isClosed()) {
        await endSession(session, this.lifecycleOptions())
        throw this.closedError()
      }
      this.phase = { kind: "running", session }
      this.scenario = scenario
      this.moveSubscribers(session, previousSessionId)
      return this.describe()
    } catch (error: unknown) {
      if (!this.isClosed()) {
        this.phase = { kind: "failed" }
      }
      throw error
    }
  }

  /**
   * A cursor from another session always resolves to `resync.required`. A subscriber
   * the new session refuses is dropped, because the session itself is fine.
   */
  private moveSubscribers(session: AppSession, previousSessionId: string): void {
    for (const [listener, stop] of this.subscribers) {
      stop()
      const since = { sessionId: previousSessionId, sequence: 0 }
      try {
        this.subscribers.set(listener, session.runtime.subscribe(listener, { since }))
      } catch (error: unknown) {
        this.subscribers.delete(listener)
        this.report(error)
      }
    }
  }

  private enqueue<A>(work: () => Promise<A>): Promise<A> {
    if (this.queuedCount >= LIFECYCLE_QUEUE_MAX) {
      return Promise.reject(
        new ProtocolError(ErrorCode.ResourceExhausted, "Too many resets are queued"),
      )
    }
    this.queuedCount++
    const next = this.lifecycle.then(work, work).finally(() => {
      this.queuedCount--
      assert(this.queuedCount >= 0, "each queued item is counted once")
    })
    // The caller owns `next` and its failure. This chain only keeps the order.
    this.lifecycle = next.catch(() => undefined)
    return next
  }

  /** A start that never finishes must not hold up close or later resets. */
  private async startSession(scenario: string): Promise<AppSession> {
    // A previous session has ended by now, unless it overran, so this counts only those.
    if (this.unfinishedSessionCount >= UNFINISHED_SESSIONS_MAX) {
      const message = "Too many sessions are still starting or ending"
      throw new ProtocolError(ErrorCode.ResourceExhausted, message)
    }
    const prefix = this.options.sessionPrefix ?? "session"
    const sessionId = `${prefix}-${++this.lastEpoch}`
    this.unfinishedSessionCount++
    const starting = startCounted(
      () => this.host.start(scenario, { sessionId, onBackgroundError: this.report }),
      () => {
        this.unfinishedSessionCount--
        assert(this.unfinishedSessionCount >= 0, "each session is counted once")
      },
    )
    const abandon = new Promise<never>((_, reject) => {
      this.abortStart = reject
    })
    try {
      return await awaitSession(starting, { ...this.lifecycleOptions(), abandon })
    } finally {
      this.abortStart = undefined
    }
  }

  private session(): AppSession {
    const { phase } = this
    switch (phase.kind) {
      case "running":
        return phase.session
      case "closed":
        throw this.closedError()
      case "failed":
        throw new ProtocolError(
          ErrorCode.SessionClosed,
          "No session: the last reset failed; reset again",
        )
      case "starting":
      case "resetting":
        throw new ProtocolError(ErrorCode.SessionClosed, "The session is being replaced")
    }
  }

  private isClosed(): boolean {
    return this.phase.kind === "closed"
  }

  private requireNotClosed(): void {
    if (this.isClosed()) {
      throw this.closedError()
    }
  }

  private closedError(): ProtocolError {
    return new ProtocolError(ErrorCode.SessionClosed, "This controller has been closed")
  }

  private requireScenario(name: string): string {
    if (this.host.scenarios.some((candidate) => candidate.name === name)) {
      return name
    }
    throw new ProtocolError(ErrorCode.ScenarioNotFound, `Unknown scenario "${name}"`, {
      scenarios: this.host.scenarios.map((candidate) => candidate.name),
    })
  }
}
