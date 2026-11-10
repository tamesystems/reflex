import {
  assert,
  type DescribeResult,
  defined,
  ErrorCode,
  LIFECYCLE_QUEUE_MAX,
  type EventCursor,
  type Methods,
  PROTOCOL_VERSION,
  ProtocolError,
  type RuntimeEvent,
} from "@reflex/protocol"
import {
  type AppSession,
  type BackgroundReporter,
  type Controller,
  type ControllerMethod,
  type ControllerSubscription,
  createControlWork,
  systemTimers,
  type Timers,
} from "@reflex/runtime"
import { type LiveSessions, liveSessionOf } from "./live-sessions.ts"

type Handlers = {
  readonly [M in ControllerMethod]: (
    params: Methods[M]["params"],
    signal: AbortSignal | undefined,
  ) => Promise<Methods[M]["result"]>
}

interface Subscriber {
  stop: () => void
  /** The session it listens to, so that the next one can tell it to resynchronize. */
  sessionId: string
}

/**
 * The protocol, served by the app on screen: what a bridge drives. Requests reach the
 * very session the UI renders, and a reset replaces what the UI shows. Subscribers move
 * to each new session and are told to resynchronize, as with a headless controller.
 */
export const createLiveController = (
  sessions: LiveSessions,
  onBackgroundError: BackgroundReporter,
  timers: Timers = systemTimers,
): Controller => new LiveController(sessions, onBackgroundError, timers)

class LiveController implements Controller {
  private readonly subscribers = new Map<(event: RuntimeEvent) => void, Subscriber>()
  private current: AppSession | null = null
  private closed = false
  /** Resets run strictly one at a time, in the order requested. */
  private lifecycle: Promise<unknown> = Promise.resolve()
  private queuedCount = 0
  private readonly stopWatching: () => void
  private readonly withinControlDeadline: ReturnType<typeof createControlWork>

  constructor(
    private readonly sessions: LiveSessions,
    private readonly report: BackgroundReporter,
    timers: Timers,
  ) {
    this.withinControlDeadline = createControlWork(timers, report)
    this.stopWatching = sessions.subscribe(() => this.follow())
    this.follow()
  }

  private readonly handlers: Handlers = {
    "app.describe": async () => this.describe(await this.session()),
    "app.inspect": async (params) => (await this.session()).runtime.inspect(params),
    "app.dispatch": async (params, signal) =>
      (await this.session()).runtime.dispatch(params, signal === undefined ? {} : { signal }),
    "app.operation": async ({ operationId }) =>
      (await this.session()).runtime.operation(operationId),
    "app.cancel": async ({ operationId }) => (await this.session()).runtime.cancel(operationId),
    "app.wait": async (params, signal) =>
      (await this.session()).runtime.wait(params, signal === undefined ? {} : { signal }),
    // One at a time, in order, so each reports the session it made.
    "app.reset": ({ scenario }) =>
      this.enqueue(async () => {
        const settled = await this.sessions.reset(scenario)
        this.requireOpen()
        if (settled.kind === "failed") {
          throw settled.cause
        }
        return this.describe(settled.session)
      }),
    "app.advanceTime": async ({ durationMs }) => {
      const { advanceTime } = await this.session()
      if (advanceTime === undefined) {
        const message = `Scenario "${this.sessions.scenario}" runs on real time`
        throw new ProtocolError(ErrorCode.Unsupported, message)
      }
      return { nowVirtualMs: await this.withinControlDeadline(() => advanceTime(durationMs)) }
    },
    "app.sample": async (params) => {
      const { runtime } = await this.session()
      return { input: await this.withinControlDeadline(() => runtime.sample(params)) }
    },
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
    const { runtime } = await this.session()
    const stop = runtime.subscribe(listener, options?.since ? { since: options.since } : {})
    this.subscribers.set(listener, { stop, sessionId: runtime.sessionId })
    return {
      unsubscribe: () => {
        this.subscribers.get(listener)?.stop()
        this.subscribers.delete(listener)
      },
      sessionId: runtime.sessionId,
      sequence: runtime.sequence,
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.stopWatching()
    for (const { stop } of this.subscribers.values()) {
      stop()
    }
    this.subscribers.clear()
  }

  /** Checked again after the wait: the controller can close while a start is pending. */
  private async session(): Promise<AppSession> {
    this.requireOpen()
    const session = await liveSessionOf(this.sessions)
    this.requireOpen()
    return session
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new ProtocolError(ErrorCode.SessionClosed, "The bridge to this app has closed")
    }
  }

  private enqueue<A>(work: () => Promise<A>): Promise<A> {
    if (this.queuedCount >= LIFECYCLE_QUEUE_MAX) {
      const message = "Too many resets are queued"
      return Promise.reject(new ProtocolError(ErrorCode.ResourceExhausted, message))
    }
    this.queuedCount++
    const next = this.lifecycle.then(work, work).finally(() => {
      this.queuedCount--
      assert(this.queuedCount >= 0, "each queued reset is counted once")
    })
    // The caller owns `next` and its failure. This chain only keeps the order.
    this.lifecycle = next.catch(() => undefined)
    return next
  }

  private describe(session: AppSession): DescribeResult {
    const host = defined(this.sessions.host ?? undefined, "a live session has a host")
    return {
      protocolVersion: PROTOCOL_VERSION,
      app: host.name,
      sessionId: session.runtime.sessionId,
      scenario: defined(this.sessions.scenario ?? undefined, "a live session has a scenario"),
      scenarios: host.scenarios,
      capabilities: { virtualTime: session.advanceTime !== undefined },
    }
  }

  /**
   * A cursor from another session always resolves to `resync.required`, so each
   * subscriber learns that what it knew is gone. One the new session refuses is dropped.
   */
  private follow(): void {
    const lifecycle = this.sessions.getSnapshot()
    if (lifecycle.kind !== "live" || lifecycle.session === this.current) {
      return
    }
    this.current = lifecycle.session
    const { runtime } = lifecycle.session
    for (const [listener, subscriber] of this.subscribers) {
      if (subscriber.sessionId === runtime.sessionId) {
        continue
      }
      subscriber.stop()
      const since = { sessionId: subscriber.sessionId, sequence: 0 }
      try {
        subscriber.stop = runtime.subscribe(listener, { since })
        subscriber.sessionId = runtime.sessionId
      } catch (error: unknown) {
        this.subscribers.delete(listener)
        this.report(error)
      }
    }
  }
}
