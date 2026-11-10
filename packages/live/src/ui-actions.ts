import { boundedText, ErrorCode, ProtocolError } from "@reflex/protocol"
import { type ActionOutcome, reportToConsole } from "@reflex/runtime/internal"

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

type ActionMap = Record<string, (...args: never[]) => Promise<ActionOutcome<unknown>>>
type ActionArgs<A extends ActionMap> = {
  [K in keyof A & string]: [action: K, ...args: Parameters<A[K]>]
}[keyof A & string]
type Outcome<A extends ActionMap> = Awaited<ReturnType<A[keyof A]>>

/** Secondary dispatch keeps correlated inputs and returns the same observable outcomes. */
export const send = <A extends ActionMap>(
  node: { readonly actions: A },
  ...[action, ...input]: NoInfer<ActionArgs<A>>
): Promise<Outcome<A>> => {
  const invoke = node.actions[action]
  if (invoke === undefined) {
    throw new Error(`Unknown action "${action}"`)
  }
  const work = invoke(...(input as never[])) as Promise<Outcome<A>>
  void work
    .then((outcome) => {
      if (
        outcome.status === "defect" ||
        (outcome.status === "domain-error" && outcome.error.tag === "ResourceExhausted")
      ) {
        reportFailure(
          new Error(`${boundedText(action)} ${outcome.error.tag}: ${outcome.error.message}`),
        )
      }
    })
    .catch(reportFailure)
  return work
}
