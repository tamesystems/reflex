import {
  boundedText,
  defined,
  ErrorCode,
  type NodeId,
  type OperationId,
  type OperationInfo,
  type OperationOutcome,
  ProtocolError,
  RETAINED_ERROR_DATA_CHARACTERS_MAX,
  RETAINED_OPERATIONS_MAX,
  type RunningOperation,
  type SettledOperation,
  toOperationId,
} from "@reflex/protocol"

export interface Invocation {
  readonly done: Promise<OperationOutcome>
  cancel(): void
}

interface OperationTarget {
  readonly nodeId: NodeId
  readonly action: string
}

interface Running {
  readonly info: RunningOperation
  /** Absent for the moment before launch, when cancelling is only remembered. */
  invocation: Invocation | undefined
  cancelRequested: boolean
}

/**
 * Running operations keep their invocation, because they can be cancelled.
 * Settled ones keep only their result: holding the invocation would retain the
 * fiber behind it and everything that closed over.
 */
export class OperationTable {
  private readonly running = new Map<OperationId, Running>()
  private readonly settled = new Map<OperationId, SettledOperation>()
  private lastIndex = 0

  /** Ids carry the session, so one kept across a reset finds nothing in the next. */
  constructor(
    private readonly sessionId: string,
    private readonly onError: (error: unknown) => void,
  ) {}

  get runningCount(): number {
    return this.running.size
  }

  /**
   * Handlers run synchronously up to their first suspension, so observers must hear
   * of an operation before it launches, and it must already be real when they do:
   * they can look it up or cancel it, and a wait for idle must count it.
   */
  start(
    target: OperationTarget,
    launch: () => Invocation,
    observers: {
      readonly onStarted: (info: RunningOperation) => void
      readonly onSettled: (info: SettledOperation) => void
    },
  ): { readonly info: RunningOperation; readonly invocation: Invocation } {
    const operationId = toOperationId(`op/${this.sessionId}/${++this.lastIndex}`)
    const info: RunningOperation = { ...target, operationId, status: "running" }
    const running: Running = { info, invocation: undefined, cancelRequested: false }
    this.running.set(operationId, running)
    observers.onStarted(info)
    const invocation = this.launch(running, launch, observers.onSettled)
    running.invocation = invocation
    if (running.cancelRequested) {
      invocation.cancel()
    }
    invocation.done
      .then(
        (outcome) => withOutcome(target, operationId, outcome),
        (cause: unknown) => withDefect(target, operationId, cause),
      )
      .then((settled) => {
        this.settle(settled)
        observers.onSettled(settled)
      })
      .catch(this.onError)
    return { info, invocation }
  }

  /** It was announced, so a launch that throws still has to end as an operation. */
  private launch(
    { info }: Running,
    launch: () => Invocation,
    onSettled: (info: SettledOperation) => void,
  ): Invocation {
    try {
      return launch()
    } catch (error: unknown) {
      const { operationId, ...target } = info
      const settled = withDefect(target, operationId, error)
      this.settle(settled)
      onSettled(settled)
      throw error
    }
  }

  lookup(operationId: OperationId): OperationInfo {
    const info = this.running.get(operationId)?.info ?? this.settled.get(operationId)
    if (info === undefined) {
      throw new ProtocolError(ErrorCode.OperationNotFound, `Unknown operation "${operationId}"`)
    }
    return info
  }

  cancel(operationId: OperationId): OperationInfo {
    const running = this.running.get(operationId)
    if (running !== undefined) {
      running.cancelRequested = true
      running.invocation?.cancel()
    }
    return this.lookup(operationId)
  }

  private settle(info: SettledOperation): void {
    this.running.delete(info.operationId)
    this.settled.set(info.operationId, withoutOversizedData(info))
    if (this.settled.size > RETAINED_OPERATIONS_MAX) {
      const [oldest] = this.settled.keys()
      this.settled.delete(defined(oldest, "a map over its limit has a first key"))
    }
  }
}

const withOutcome = (
  target: OperationTarget,
  operationId: OperationId,
  outcome: OperationOutcome,
): SettledOperation => ({ ...target, operationId, ...outcome })

const withDefect = (
  target: OperationTarget,
  operationId: OperationId,
  cause: unknown,
): SettledOperation => ({
  ...target,
  operationId,
  status: "failed",
  error: { tag: "Defect", message: boundedText(String(cause)), defect: true },
})

const withoutOversizedData = (info: SettledOperation): SettledOperation => {
  if (info.status !== "failed" || info.error.data === undefined) {
    return info
  }
  if (JSON.stringify(info.error.data).length <= RETAINED_ERROR_DATA_CHARACTERS_MAX) {
    return info
  }
  const { data: _, ...error } = info.error
  return { ...info, error }
}
