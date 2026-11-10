# @reflex/effect

Contracts precede implementations. Navigation imports contracts; features import navigation.
One app value then supplies host bindings and journey membership.

```ts
import { defineApp, defineNavigation, defineScreen } from "@reflex/effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const DetailScreen = defineScreen({
  name: "Detail",
  state: Schema.NumberFromString,
  params: Schema.Struct({ id: Schema.String }),
  initial: () => 0,
})
const Nav = defineNavigation("app/Navigation", { Detail: DetailScreen })
const Detail = DetailScreen.implement({
  actions: (action) => ({
    Open: action({ handler: () => Nav.push("Detail", { id: "next" }) }),
    Close: action({ handler: () => Nav.back }),
  }),
})
export const app = defineApp({
  name: "detail",
  navigation: Nav.implement({ Detail }, { initial: { route: "Detail", params: { id: "first" } } }),
  scenarios: { default: { layer: Layer.empty } },
  defaultScenario: "default",
})
```

A param-free initial route can be a string. Navigation runs after a successful handler;
returning from a pop reports `completed`. Stack/build refusals become `refused` without
an action error declaration. Other failures require `error: Schema`. Only checked values
from the action builder may appear in an action map.

Contracts share runtime identity with every implementation. Composition checks identity,
checks literal names, and rejects duplicate/conflicting implementations. TypeScript cannot
generate a fresh nominal type on every function call: where independently declared
same-name contracts must be distinguished statically, pass `identity: token` with an
explicit `const token = Symbol("Detail")` unique symbol. No token is needed for ordinary
unique names. Navigator keys must be unique in an app.

`InferState`, `InferInput` and `InferError` describe encoded consumer values; handlers keep
decoded values. Tuples retain positions and length. `action.when(tag)` narrows state and
rechecks the tag at commit. `state.when(tag)` selects another phase after suspension.
`Screen.handler` and `Screen.when(tag).handler` infer shared helper arguments. Focus hooks
handle expected load errors into state; their error channel is empty.

Root exports are the four definers, `action` (a standalone state-bound builder factory)
and `Infer*` types. `/advanced` holds ownership types and `mount` for custom non-navigation
roots. `/internal` holds registry, `mountWithAccess` for fixtures, redaction, decoded
dispatch and custom factory navigation. Scenarios stay plain Layers; declare fixtures once
with `defineApp({ fixtures: { Fixture }, ... })`.

[ADR 0022](../../docs/decisions/0022-contract-identity-and-app-bindings.md) records these changes.
