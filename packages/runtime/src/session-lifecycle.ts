import {
  ErrorCode,
  ProtocolError,
  SESSION_DISPOSE_TIMEOUT_MS_DEFAULT,
  SESSION_START_TIMEOUT_MS_DEFAULT,
} from "@reflex/protocol"
import type { AppSession } from "./controller.ts"
import type { BackgroundReporter } from "./reporting.ts"
import { type Timers, withDeadline } from "./timers.ts"

export interface SessionLifecycleOptions {
  readonly timers: Timers
  readonly onBackgroundError: BackgroundReporter
  readonly startTimeoutMs?: number
  readonly disposeTimeoutMs?: number
}

type StartOutcome =
  | { readonly kind: "started"; readonly session: AppSession }
  | { readonly kind: "failed"; readonly cause: unknown }

/**
 * Starts a session that holds its slot until its work is really over. A deadline gives
 * up on a start or a disposal, but cannot cancel it, so that is no time to release.
 */
export const startCounted = async (
  start: () => Promise<AppSession>,
  release: () => void,
): Promise<AppSession> => {
  let session: AppSession
  try {
    session = await start()
  } catch (error: unknown) {
    release()
    throw error
  }
  const advanceTime = session.advanceTime?.bind(session)
  return {
    runtime: session.runtime,
    ...(advanceTime === undefined ? {} : { advanceTime }),
    dispose: async () => {
      try {
        await session.dispose()
      } finally {
        release()
      }
    },
  }
}

/** Closes first, so that anything finishing during disposal sees the session is over. */
export const endSession = async (
  session: AppSession,
  options: SessionLifecycleOptions,
): Promise<void> => {
  session.runtime.close()
  let overdue = false
  const disposal = session.dispose()
  // Past the deadline the caller has moved on, so a late failure has nobody else.
  disposal.catch((error: unknown) => {
    if (overdue) {
      options.onBackgroundError(error)
    }
  })
  await withDeadline(disposal, {
    timeoutMs: options.disposeTimeoutMs ?? SESSION_DISPOSE_TIMEOUT_MS_DEFAULT,
    timers: options.timers,
    overdue: () => {
      overdue = true
      return new Error("Session did not dispose in time")
    },
  })
}

/**
 * Waits for a start, within its deadline or until `abandon` rejects. Whatever
 * happens, the session has an owner: the caller if this returns it, and otherwise
 * this function, which ends it if the start ever does finish.
 */
export const awaitSession = async (
  starting: Promise<AppSession>,
  options: SessionLifecycleOptions & {
    readonly abandon?: Promise<never>
  },
): Promise<AppSession> => {
  // Outcomes rather than rejections, to tell a start that failed, whose caller
  // hears about it, from one abandoned here, which nobody is waiting on any more.
  const outcome = starting.then(
    (session): StartOutcome => ({ kind: "started", session }),
    (cause: unknown): StartOutcome => ({ kind: "failed", cause }),
  )
  const raced = options.abandon === undefined ? outcome : Promise.race([outcome, options.abandon])
  let finished: StartOutcome
  try {
    finished = await withDeadline(raced, {
      timeoutMs: options.startTimeoutMs ?? SESSION_START_TIMEOUT_MS_DEFAULT,
      timers: options.timers,
      overdue: () =>
        new ProtocolError(ErrorCode.SessionClosed, "The session did not start in time"),
    })
  } catch (error: unknown) {
    discardLateSession(outcome, options)
    throw error
  }
  if (finished.kind === "failed") {
    throw finished.cause
  }
  return finished.session
}

const discardLateSession = (
  outcome: Promise<StartOutcome>,
  options: SessionLifecycleOptions,
): void => {
  outcome
    .then(async (late) => {
      if (late.kind === "started") {
        await endSession(late.session, options)
      } else {
        options.onBackgroundError(late.cause)
      }
    })
    .catch(options.onBackgroundError)
}
