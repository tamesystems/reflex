import { assert, ErrorCode, ProtocolError, UNFINISHED_SESSIONS_MAX } from "@reflex/protocol"
import {
  type AppHost,
  type AppSession,
  awaitSession,
  type BackgroundReporter,
  endSession,
  startCounted,
  type Timers,
} from "@reflex/runtime/internal"

/** The current session, plus those whose start or disposal has yet to finish. */
const OWNED_SESSIONS_MAX = UNFINISHED_SESSIONS_MAX + 1

export type SessionLifecycle =
  | { readonly kind: "starting" }
  | { readonly kind: "live"; readonly session: AppSession }
  | { readonly kind: "failed"; readonly cause: unknown }

export interface SessionOwnerOptions {
  readonly timers: Timers
  readonly onBackgroundError: BackgroundReporter
  readonly onChange: (lifecycle: SessionLifecycle) => void
  /**
   * Starts every session id, so ids from different runs of the app differ: a cursor
   * from before a reload must not resume against a session that only shares a number.
   */
  readonly sessionPrefix?: string
}

/**
 * Owns the sessions a provider starts: at most one is current, and every other is
 * ended, however its start turns out and in whatever order. No React in here, so
 * that those orders can be tested.
 */
export class SessionOwner {
  private lastEpoch = 0
  /**
   * Counted until the work itself is over, not until a deadline gives up on it:
   * neither a start nor a disposal can be cancelled, so both can outlast this.
   */
  private unfinishedCount = 0

  constructor(private readonly options: SessionOwnerOptions) {}

  /** Returns what ends this session, or abandons its start. */
  start(host: AppHost, scenario: string | undefined): () => void {
    const { onChange, onBackgroundError } = this.options
    if (this.unfinishedCount >= OWNED_SESSIONS_MAX) {
      const message = "Too many sessions are still starting or ending"
      onChange({ kind: "failed", cause: new ProtocolError(ErrorCode.ResourceExhausted, message) })
      return () => undefined
    }
    this.lastEpoch++
    onChange({ kind: "starting" })
    let started: AppSession | null = null
    let replaced = false
    awaitSession(this.counted(host, scenario), this.options)
      .then((session) => {
        if (replaced) {
          this.end(session)
        } else {
          started = session
          onChange({ kind: "live", session })
        }
      })
      .catch((cause: unknown) => {
        // A start that was replaced can no longer affect what is on screen.
        if (replaced) {
          onBackgroundError(cause)
        } else {
          onChange({ kind: "failed", cause })
        }
      })
    return () => {
      replaced = true
      if (started !== null) {
        this.end(started)
      }
    }
  }

  /** A session's slot is held from the start of its start to the end of its disposal. */
  private async counted(host: AppHost, scenario: string | undefined): Promise<AppSession> {
    this.unfinishedCount++
    const release = () => {
      this.unfinishedCount--
      assert(this.unfinishedCount >= 0, "each session is counted once")
    }
    const sessionId = `${this.options.sessionPrefix ?? "session"}-${this.lastEpoch}`
    const { onBackgroundError } = this.options
    return startCounted(
      () => host.start(scenario ?? host.defaultScenario, { sessionId, onBackgroundError }),
      release,
    )
  }

  private end(session: AppSession): void {
    endSession(session, this.options).catch(this.options.onBackgroundError)
  }
}
