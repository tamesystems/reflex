import { Screen, defineApp } from "@reflex/effect"
import { createReflex } from "@reflex/react"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Layer from "effect/Layer"
import { InventoryList } from "./examples/inventory/src/screens.ts"
import { InventoryApi } from "./examples/inventory/src/domain.ts"
import * as Effect from "effect/Effect"
import { httpInventoryApi } from "./examples/inventory/src/http-api.ts"
import { memorySettings } from "./examples/inventory/src/settings-store.ts"

export class EncodedState extends Screen("EncodedState", {
  state: Schema.NumberFromString,
  initial: () => 1,
}) {}
export const EncodedLive = EncodedState.implement({
  actions: (action) => ({ Increment: action.reduce({ reducer: (_, n) => n + 1 }) }),
})
const reflex = createReflex(defineApp({ name: "encoded-state", screens: [EncodedLive] }))
export function EncodedView() {
  const view = reflex.useScreenStatus(EncodedState)
  if (view.status === "ready") {
    const encoded: string = view.state
    void encoded
  }
  return null
}
const Reader = InventoryList.implement({
  actions: (action) => ({
    Read: action({
      handler: () =>
        Effect.gen(function* () {
          yield* InventoryApi
        }),
    }),
  }),
})
const commonLayer = Layer.merge(httpInventoryApi("http://127.0.0.1:4318"), memorySettings)
export const common = defineApp({
  name: "common",
  screens: [Reader],
  layer: commonLayer,
  scenarios: { default: {} },
  defaultScenario: "default",
})
export const extended = common.withScenarios({ other: {} }, { defaultScenario: "other" })
export const twice = extended.withScenarios({ third: {} })
const oldDefault: "default" = common.defaultScenario
const newDefault: "other" = twice.defaultScenario
void oldDefault
void newDefault

export class Secret extends Screen("Secret", {
  state: Schema.Struct({ token: Schema.Redacted(Schema.String) }),
  initial: () => ({ token: Redacted.make("fixture-only") }),
}) {}
const SecretLive = Secret.implement({ actions: () => ({}) })
const secretBinding = createReflex(defineApp({ name: "secret", screens: [SecretLive] }))
export function SecretView() {
  const view = secretBinding.useScreenStatus(Secret)
  if (view.status === "ready") {
    const safe: "<redacted>" = view.state.token
    void safe
  }
  return null
}
