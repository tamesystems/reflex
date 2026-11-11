import { Screen } from "@reflex/effect"
import type { LiveNode } from "@reflex/effect/internal"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { send } from "../src/ui-actions.ts"

const Detail = Screen.define("Detail", {
  initial: () => ({ quantity: 0 }),
  state: Schema.Struct({ quantity: Schema.Number }),
  actions: (action) => ({
    Save: action({ handler: () => Effect.void }),
    SetQuantity: action({
      input: Schema.Struct({ quantity: Schema.Number }),
      handler: ({ quantity }, { state }) => state.update(() => ({ quantity })),
    }),
  }),
})

/** Typechecked, never run: errors must be at the invalid argument. */
export const consumer = (node: LiveNode<typeof Detail.state.Type, typeof Detail.actions>) => {
  void send(node, "Save")
  void send(node, "SetQuantity", { quantity: 1 })
  void node.actions.Save()
  void node.actions.SetQuantity({ quantity: 2 })
  // @ts-expect-error Required input is missing.
  void send(node, "SetQuantity")
  // @ts-expect-error A no-input action takes no payload.
  void send(node, "Save", { quantity: 1 })
  // @ts-expect-error Wrong input type.
  void node.actions.SetQuantity({ quantity: "1" })
  // @ts-expect-error Unknown action.
  void node.actions.Missing()
  // @ts-expect-error Extra input fields are rejected.
  void node.actions.SetQuantity({ quantity: 1, extra: true })
}

class Rejected extends Schema.TaggedError<Rejected>()("Rejected", { message: Schema.String }) {}
class OtherError extends Schema.TaggedError<OtherError>()("OtherError", {}) {}
export const ErrorContract = Screen.define("ErrorContract", {
  initial: () => 0,
  state: Schema.Number,
  actions: (action) => ({
    Encoded: action({
      error: Schema.Struct({ message: Schema.String }).pipe(
        Schema.encodeKeys({ message: "public_message" }),
      ),
      handler: () => Effect.fail({ message: "no" }),
    }),
    Declared: action({
      error: Rejected,
      handler: () => Effect.fail(new Rejected({ message: "no" })),
    }),
    Undeclared: action({
      // @ts-expect-error Failure channels must be declared.
      handler: () => Effect.fail(new Rejected({ message: "no" })),
    }),
    Mismatch: action({
      error: Rejected,
      // @ts-expect-error The handler must fail with the declared error.
      handler: () => Effect.fail(new OtherError({})),
    }),
  }),
})

export const errorConsumer = async (node: LiveNode<number, typeof ErrorContract.actions>) => {
  const outcome = await node.actions.Encoded()
  if (outcome.status === "domain-error" && outcome.error.data !== undefined) {
    const message: string = outcome.error.data.public_message
    // @ts-expect-error Clients see the encoded error, not its server-side field name.
    outcome.error.data.message
    return message
  }
  return undefined
}

const Parsed = Screen.define("Parsed", {
  initial: () => 0,
  state: Schema.Number,
  actions: (action) => ({
    Set: action({
      input: Schema.NumberFromString,
      handler: (value, { state }) => state.update(() => value),
    }),
  }),
})
export const inputConsumer = (node: LiveNode<number, typeof Parsed.actions>) => {
  void node.actions.Set("12")
  // @ts-expect-error Consumers supply the encoded input, handlers receive the decoded number.
  void node.actions.Set(12)
}
