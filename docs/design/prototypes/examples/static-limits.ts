import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Screen } from "@reflex/effect"
import { Nav } from "./examples/inventory/src/navigation.ts"
import { InventoryDetail, InventoryList } from "./examples/inventory/src/screens.ts"
import { createReflexRouter } from "@reflex/react-router"
import { app } from "./codecs.ts"
import { Count } from "./codecs.ts"

// Deliberate compilable counterexamples, NOT recommended author idioms.
// TypeScript erases commands through Effect<void>. Lint/runtime remains necessary.
const erased: Effect.Effect<void> = Effect.succeed(Nav.back)
InventoryList.implement({ actions: (action) => ({ Erased: action({ handler: () => erased }) }) })
// A plain action can discard an expression. The runtime rejects an unused command.
InventoryList.implement({
  actions: (action) => ({
    Dropped: action({
      handler: () =>
        Effect.gen(function* () {
          yield* Effect.void
          Nav.back
        }),
    }),
  }),
})
// Private declarations are inherited. Registry lookup must use exact constructors.
export class Subclass extends InventoryDetail {}
const assignable: typeof InventoryDetail = Subclass
void assignable
// Private nominal line cannot be inspected structurally by a library.
export class MissingNominal extends Screen("MissingNominal", {
  state: Schema.Number,
  initial: () => 0,
}) {}
// JS class name differs from declared contract name. Diagnostics use the latter.
export class DifferentClassName extends Screen("DeclaredName", {
  state: Schema.Number,
  initial: () => 0,
}) {
  declare private readonly nominal: undefined
}
// A 60-segment root route is accepted without TS2589 (tail accumulator parser).
export const longPath = createReflexRouter(app, {
  Count:
    "/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/part/:count",
})
longPath.href(Count, { count: "1" })
