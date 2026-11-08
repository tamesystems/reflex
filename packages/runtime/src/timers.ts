import { assert } from "@reflex/protocol"

/** Time is external input, so a test can replace these. */
export interface Timers {
  setTimeout(callback: () => void, durationMs: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemTimers: Timers = {
  setTimeout: (callback, durationMs) => setTimeout(callback, durationMs),
  // Only ever given back what `setTimeout` above returned.
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Settles with `work`, or rejects with `overdue()` if that takes too long. */
export const withDeadline = async <A>(
  work: Promise<A>,
  options: {
    readonly timeoutMs: number
    readonly timers: Timers
    readonly overdue: () => Error
  },
): Promise<A> => {
  const { timers, timeoutMs, overdue } = options
  assert(timeoutMs > 0, "a deadline is in the future")
  let handle: unknown
  const expiry = new Promise<never>((_, reject) => {
    handle = timers.setTimeout(() => reject(overdue()), timeoutMs)
  })
  try {
    return await Promise.race([work, expiry])
  } finally {
    timers.clearTimeout(handle)
  }
}
