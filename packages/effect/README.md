# @reflex/effect

Contracts precede handlers, so navigation never imports feature implementations:

```ts
const DetailScreen = defineScreen({
  name: "Detail",
  state: Schema.TaggedStruct("loading", { id: Schema.String }),
  params: Schema.Struct({ id: Schema.String }),
  initial: ({ id }) => ({ _tag: "loading", id }),
})
const Nav = defineNavigation("app/Navigation", { Detail: DetailScreen })
const Detail = DetailScreen.implement({
  actions: (action) => ({
    Open: action({ error: NavigationRefused, handler: () => Nav.push("Detail", { id: "next" }) }),
  }),
})
const root = Nav.layer({
  screens: { Detail },
  initial: { route: "Detail", params: { id: "first" } },
})
```

Use unique navigation keys. Push tuples keep route/params correlated. A route without
params takes no argument. The app derives screen membership from `root`; scenario fixture
layers use `withNodes(layer, { Fixture })`. `InferState`, `InferInput` and `InferError`
derive consumer wire types. Handlers keep decoded state.

`action.when(tag)` narrows reads and updates, rechecking the tag at commit.
`state.when(otherTag)` selects another transition phase after asynchronous work.
`Screen.handler` and `Screen.when(tag).handler` infer shared helper arguments.
Handle focus errors into state; `onFocus` has no declared failure channel.
`mount(capability, initial, { focus: true })` supports Effect apps without navigation.

Normal handles expose `actions`; `dispatchDecoded`, `mountOwned`, registry, redaction and
custom factory navigation are integration APIs under `/internal`. `mountWithAccess` is
for fixture/service owners retaining the sole state write path. Popping a navigation
entry retires its node before closing the scope and cancelling its work.

See [ADR 0021](../../docs/decisions/0021-contracts-before-implementations.md) for limitations,
including custom JSON hooks and static identity for same-name definitions.
