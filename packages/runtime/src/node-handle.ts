import {
  ErrorCode,
  boundedText,
  type NodeId,
  type OperationError,
  type OperationInfo,
  ProtocolError,
} from "@reflex/protocol"

/** A local consumer sees refusals as well as the operation's eventual result. */
export type ActionOutcome<E = never> =
  | { readonly status: "completed" }
  | { readonly status: "cancelled" }
  | { readonly status: "refused"; readonly reason: string; readonly code: number }
  | {
      readonly status: "domain-error"
      readonly error: Omit<OperationError, "data"> & { readonly data?: E }
    }
  | { readonly status: "defect"; readonly error: OperationError }

export interface NodeHandle<S, A> {
  readonly id: NodeId
  readonly name: string
  readonly actions: A
  getSnapshot(): S
  subscribe(listener: () => void): () => void
  subscribeAvailability(listener: () => void): () => void
  availability(action: keyof A & string): true | string
  dispose(): void
}

/** The wire operation stays unchanged; this is its application-facing view. */
export const actionOutcome = async <E>(
  work: () => Promise<OperationInfo>,
): Promise<ActionOutcome<E>> => {
  try {
    const operation = await work()
    switch (operation.status) {
      case "completed":
        return { status: "completed" }
      case "cancelled":
        return { status: "cancelled" }
      case "failed":
        return operation.error.defect
          ? { status: "defect", error: operation.error }
          : // Adapters validate and encode declared data before it reaches this boundary.
            {
              status: "domain-error",
              error: operation.error as Omit<OperationError, "data"> & { readonly data?: E },
            }
      case "running":
        throw new Error("An awaited action is still running")
    }
  } catch (error) {
    if (error instanceof ProtocolError) {
      return { status: "refused", code: error.code, reason: error.message }
    }
    return {
      status: "defect",
      error: {
        tag: "Defect",
        defect: true,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/** Build one action object per node, preserving each action's argument tuple. */
export const bindActions = <A>(
  names: ReadonlyArray<string>,
  run: (name: string, args: unknown[]) => Promise<ActionOutcome<unknown>>,
): A =>
  Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => run(name, args)])) as A

/** The definition owns serialization; journeys supply only a transport. */
export interface ConsumerDefinition<S = unknown, A = unknown> {
  readonly name: string
  readonly client: {
    input(action: string, args: readonly unknown[]): import("@reflex/protocol").Json | undefined
    state(raw: import("@reflex/protocol").Json): S
    actions(
      run: (action: string, input?: import("@reflex/protocol").Json) => Promise<OperationInfo>,
    ): A
  }
}

/** Keep validation errors at the caller's node, action and schema field. */
export const decodeActionInput = <I>(
  node: string,
  action: string,
  raw: unknown,
  decode: (value: unknown) => I,
): I => {
  try {
    return decode(raw)
  } catch (error) {
    if (error instanceof ProtocolError && error.code === ErrorCode.InvalidInput) {
      throw new ProtocolError(
        error.code,
        boundedText(`${node}.${action}: ${error.message}`),
        error.data,
      )
    }
    throw error
  }
}
