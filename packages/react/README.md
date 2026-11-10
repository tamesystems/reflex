# @reflex/react

`ReflexProvider` owns the session and resets its subtree when session identity changes.
`useNode(Definition, { focus: true })` composes an ambient node's state, guards and actions.
Router adapters expose the same view through `useScreen`:

```tsx
const view = useNode(Counter, { focus: true })
if (view.status === "pending") return <p>Loading…</p>
return <button disabled={!view.actions.Add.available} onClick={() => view.actions.Add.run({ by: 1 })}>{view.state.count}</button>
```

Action views have `run`, `available`, `reason` and `pending`. They report unexpected
failures even when a UI ignores a returned promise. `useNodeState(nonNullNode)` returns
non-null state. `useAction` and `useNodeFocus` remain granular integration hooks.
`useNode` subscribes to registry membership; guard subscriptions are independent of public
state equality. `useSession(app)` uses the app as a type witness for scenario controls,
including when the provider uses a development host wrapping it.

`/advanced` is the documented application escape hatch for raw runtime/source access and
secondary dispatch. `/internal` is the sibling adapter seam for route selection and raw
sessions; it is separate to avoid making implementation plumbing part of the app API.
The optional `/effect` entry supplies capability lookup for custom bindings. The default
entry imports no Effect, router, native framework, or bridge dialler.
