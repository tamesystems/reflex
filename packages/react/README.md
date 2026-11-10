# @reflex/react

Bind session controls to a real app with `createReflex(app)`. Its `Provider` supplies that
app, `useSession()` checks scenario names, and `useNode(Definition)` accepts Effect and
store definitions. Hooks check provider identity. Router adapters add `useScreen(Contract)`.

```tsx partial: component body; Counter and bindings come from the app module
const view = useNode(Counter, { focus: true })
if (view.status === "pending") return <p>Loading…</p>
return <button disabled={!view.actions.Add.available} onClick={() => view.actions.Add.run({ by: 1 })}>{view.state.count}</button>
```

`ScreenView<typeof Definition>` derives a composed view. Action controls expose `run`,
`available`, `reason` and `pending`; unexpected local failures report through the runtime.
`useNodeState`, `useAction`, `useNodeFocus` and `useMountedNode` are granular hooks.
Guard subscriptions update even when public state is unchanged. Session reset replaces
the subtree and disposes owned nodes.

The package has `.` and `/advanced`. The latter supplies raw runtime/source access,
secondary dispatch and sibling route/session seams. The default entry imports no Effect,
router, native framework, or bridge dialler. Router adapters offer `useScreenSuspense`
next to the pending/ready view; Suspense resources belong to their session.
