import {
  assert,
  CONTROL_REQUEST_TIMEOUT_MS,
  ErrorCode,
  OUTSTANDING_CONTROL_REQUESTS_MAX,
  ProtocolError,
} from "@reflex/protocol"
import type { BackgroundReporter } from "./reporting.ts"
import { type Timers, withDeadline } from "./timers.ts"

/**
 * For requests that run app code with no deadline of their own, such as sampling an
 * input or moving virtual time. App code cannot be cancelled from here, so work past
 * its deadline stays counted until it really ends, and a late failure still reaches
 * someone. Every controller uses one, so a live app is held to what a headless one is.
 */
export const createControlWork = (timers: Timers, report: BackgroundReporter) => {
  let outstandingCount = 0
  return async <A>(start: () => Promise<A>): Promise<A> => {
    if (outstandingCount >= OUTSTANDING_CONTROL_REQUESTS_MAX) {
      throw new ProtocolError(ErrorCode.ResourceExhausted, "Too many control requests are running")
    }
    outstandingCount++
    let overdue = false
    // In an async function, so that `start` throwing is a rejection, and releases too.
    const work = (async () => start())()
    work
      .catch((error: unknown) => {
        if (overdue) {
          report(error)
        }
      })
      .then(() => {
        outstandingCount--
        assert(outstandingCount >= 0, "each control request is counted once")
      })
      .catch(report)
    return withDeadline(work, {
      timeoutMs: CONTROL_REQUEST_TIMEOUT_MS,
      timers,
      overdue: () => {
        overdue = true
        return new ProtocolError(ErrorCode.WaitTimeout, "The app did not respond in time")
      },
    })
  }
}
