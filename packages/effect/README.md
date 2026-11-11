# @reflex/effect

Contracts precede implementations. Navigation imports contracts; features import navigation.
Actions receive decoded input and `{ state }`. Consumers observe encoded JSON values.

```ts
import { Screen, defineApp, defineNavigation } from "@reflex/effect"
import * as Schema from "effect/Schema"

class DetailScreen extends Screen("Detail", {
  state: Schema.NumberFromString,
  params: { id: Schema.String },
  initial: () => 0,
}) {}
const Nav = defineNavigation({ Detail: DetailScreen })
const Detail = DetailScreen.implement({
  actions: (action) => ({
    Increment: action.reduce({ reducer: (_, count) => count + 1 }),
    Open: action.navigates({ handler: () => Nav.push(DetailScreen, { id: "next" }) }),
    Close: action.navigates({ handler: () => Nav.back }),
  }),
})
export const app = defineApp({
  name: "detail",
  navigation: Nav.implement([Detail], {
    initial: { screen: DetailScreen, params: { id: "first" } },
  }),
})
```

Use `Screen.define(name, spec)` for a one-step screen with no params. `defineService`
creates ambient service nodes. `defineFixture` creates scenario-local state access that
can also be yielded from a service Layer. Its controls remain observable fixture nodes.

`action.when(tag)` narrows state and checks availability before dispatch. Guarded writes
recheck the current tag atomically; a suspended handler cannot overwrite another variant.
`state.set`, `state.update` and `state.when(tag)` share the same validated write path.
`Screen.handler` and `Screen.when(tag).handler` infer shared `(input, ctx)` helpers.
Focus hooks handle expected failures into state.

`action.navigates` accepts bare commands or Effects returning a command. Return
`Nav.push(Screen, params)`, `Nav.back` or `Nav.stay`. The handler and its child scope
finish before navigation runs. Push/back report `completed`; navigation refusal reports
`refused` after optional `onRefused` state recovery. Discarded commands and commands
from a different navigator produce diagnostics. Navigation uses exact contract identity.

Inputs, errors, params and state must encode JSON. `/advanced` exports `jsonCodec` for
explicit custom wire representations. `InferState`, `InferActions`, `InferInput` and
`InferError` describe encoded consumer values; handlers keep decoded values.

App provision order is fixtures → common `layer` → scenario `layer` → handlers. Each
stage must satisfy its inputs from earlier stages. A layer cannot satisfy its own inputs.
Omitting scenarios creates the literal `default` scenario and still checks coverage.
`.withScenarios(extra, options)` adds names, preserves existing scenario fixtures, and
can select a new default and fixture defaults for the new scenarios.

Pass the authored app directly to app-bound UI factories, `createTestApp` and the CLI.
The symbol-keyed session host adapter stays internal to the integration.

State access belongs to its mounted node. Published state is detached and deeply frozen
through the same JSON publication boundary as store nodes. See
[ADR 0020](../../docs/decisions/0020-userland-api.md).
