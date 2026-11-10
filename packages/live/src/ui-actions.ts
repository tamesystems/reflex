import { boundedText, ErrorCode, type OperationInfo, ProtocolError } from "@reflex/protocol"
import { reportToConsole } from "@reflex/runtime"

/** Refusals that ordinary use produces: a double tap, a tap on a closing screen. */
const EXPECTED_REFUSALS: ReadonlySet<number> = new Set([
  ErrorCode.ActionUnavailable,
  ErrorCode.NodeNotFound,
  ErrorCode.SessionClosed,
])

export const reportFailure = (error: unknown): void => {
  if (error instanceof ProtocolError && EXPECTED_REFUSALS.has(error.code)) {
    return
  }
  reportToConsole(error)
}

const reportOperationFailure = (operation: OperationInfo): void => {
  if (
    operation.status === "failed" &&
    (operation.error.defect || operation.error.tag === "ResourceExhausted")
  ) {
    const action = boundedText(operation.action)
    reportFailure(new Error(`${action} ${operation.error.tag}: ${operation.error.message}`))
  }
}

/**
 * Fire an action from a UI event. Expected stale taps are ignored; resource
 * refusals and defects are reported because app state may not explain them.
 */
export const send = <Args extends unknown[]>(
  node: { send(...args: Args): Promise<OperationInfo> },
  ...args: Args
): void => {
  node
    .send(...args)
    .then(reportOperationFailure)
    .catch(reportFailure)
}
