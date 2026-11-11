import { ErrorCode, LIFECYCLE_QUEUE_MAX, ProtocolError } from "@reflex/protocol"
import type { AppHost, AppSession, BackgroundReporter, Timers } from "@reflex/runtime/internal"
import { type SessionLifecycle, SessionOwner } from "./session-owner.ts"

export interface LiveSessionsOptions {
  readonly timers: Timers
  readonly onBackgroundError: BackgroundReporter
  readonly sessionPrefix?: string
}

interface Target {
  readonly host: AppHost
  readonly scenario: string
}

interface Settling {
  resolve(lifecycle: SettledLifecycle): void
}

export type SettledLifecycle = Exclude<SessionLifecycle, { readonly kind: "starting" }>

/** No two runs of an app should hand out the same session ids. Not a secret. */
const runPrefix = (): string => `app-${Math.random().toString(36).slice(2, 10)}`

/**
 * The sessions a provider shows, as an external store. The provider says which host and
 * scenario to run; a reset (from a bridge, say) restarts it, on another scenario if asked,
 * until the provider next says otherwise. No React in here.
 */
export class LiveSessions {
  private lifecycle: SessionLifecycle = { kind: "starting" }
  private target: Target | null = null
  private release: (() => void) | null = null
  /** Each `open` gets its own; closing an older one must not end a newer one. */
  private lastOpening = 0
  private resetQueue: Promise<unknown> = Promise.resolve()
  private queuedResets = 0
  private readonly owner: SessionOwner
  private readonly listeners = new Set<() => void>()
  private readonly settling = new Set<Settling>()

  constructor(options: LiveSessionsOptions) {
    this.owner = new SessionOwner({
      timers: options.timers,
      onBackgroundError: options.onBackgroundError,
      onChange: (lifecycle) => this.change(lifecycle),
      sessionPrefix: options.sessionPrefix ?? runPrefix(),
    })
  }

  readonly getSnapshot = (): SessionLifecycle => this.lifecycle

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get host(): AppHost | null {
    return this.target?.host ?? null
  }

  get scenario(): string | null {
    return this.target?.scenario ?? null
  }

  /** Runs `host` until the returned function is called. */
  open(host: AppHost, scenario: string | undefined): () => void {
    const opening = ++this.lastOpening
    this.target = { host, scenario: scenario ?? host.defaultScenario }
    this.restart()
    return () => {
      if (opening !== this.lastOpening) {
        return
      }
      this.release?.()
      this.release = null
      this.target = null
      // An abandoned start never reports again, so whoever waits on it is told here.
      const cause = new ProtocolError(ErrorCode.SessionClosed, "The app is not running")
      this.settle({ kind: "failed", cause })
    }
  }

  /** Starts over, on `scenario` if given. Settles with how that start turns out. */
  reset(scenario: string | undefined): Promise<SettledLifecycle> {
    if (this.queuedResets >= LIFECYCLE_QUEUE_MAX) {
      return Promise.reject(
        new ProtocolError(ErrorCode.ResourceExhausted, "Too many resets are queued"),
      )
    }
    const opening = this.lastOpening
    this.queuedResets++
    const work = this.resetQueue.then(() => {
      if (opening !== this.lastOpening) {
        throw new ProtocolError(
          ErrorCode.SessionClosed,
          "The provider changed while reset was queued",
        )
      }
      return this.resetNow(scenario)
    })
    this.resetQueue = work.catch(() => undefined)
    return work.finally(() => {
      this.queuedResets--
    })
  }
  private resetNow(scenario: string | undefined): Promise<SettledLifecycle> {
    const { target } = this
    if (target === null) {
      return Promise.reject(new ProtocolError(ErrorCode.SessionClosed, "The app is not running"))
    }
    const next = scenario ?? target.scenario
    if (!target.host.scenarios.some((candidate) => candidate.name === next)) {
      const scenarios = target.host.scenarios.map((candidate) => candidate.name)
      const message = `Unknown scenario "${next}"`
      return Promise.reject(new ProtocolError(ErrorCode.ScenarioNotFound, message, { scenarios }))
    }
    if (this.settling.size >= LIFECYCLE_QUEUE_MAX) {
      const message = "Too many resets are queued"
      return Promise.reject(new ProtocolError(ErrorCode.ResourceExhausted, message))
    }
    // Registered first: a start can fail before `restart` returns.
    const settled = this.whenSettledNext()
    this.target = { host: target.host, scenario: next }
    this.restart()
    return settled
  }

  /** The current lifecycle once it is not starting, which may be now. */
  settled(): Promise<SettledLifecycle> {
    const { lifecycle } = this
    return lifecycle.kind === "starting" ? this.whenSettledNext() : Promise.resolve(lifecycle)
  }

  private whenSettledNext(): Promise<SettledLifecycle> {
    return new Promise((resolve) => {
      this.settling.add({ resolve })
    })
  }

  private restart(): void {
    const { target } = this
    if (target === null) {
      return
    }
    this.release?.()
    this.release = this.owner.start(target.host, target.scenario)
  }

  private settle(lifecycle: SettledLifecycle): void {
    for (const waiter of this.settling) {
      waiter.resolve(lifecycle)
    }
    this.settling.clear()
  }

  private change(lifecycle: SessionLifecycle): void {
    this.lifecycle = lifecycle
    if (lifecycle.kind !== "starting") {
      this.settle(lifecycle)
    }
    for (const listener of this.listeners) {
      listener()
    }
  }
}

/** The live session, or why there is none. Waits out a start in progress. */
export const liveSessionOf = async (sessions: LiveSessions): Promise<AppSession> => {
  const lifecycle = await sessions.settled()
  if (sessions.host === null) {
    throw new ProtocolError(ErrorCode.SessionClosed, "The app is not running")
  }
  if (lifecycle.kind === "live") {
    return lifecycle.session
  }
  throw new ProtocolError(
    ErrorCode.SessionClosed,
    "No session: the app's last start failed; reset to try again",
  )
}
