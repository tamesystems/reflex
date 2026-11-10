# @reflex/react

React bindings for any AppHost, with no router, Effect, Expo or React Native dependency.

`ReflexProvider` owns sessions and resets its subtree when session identity changes.
`useNode(Definition)` retains inferred store state/actions; `useNodeState(node)` subscribes
to structural state sources. `useAction(node, "Save")` returns typed `run`, guard availability
and reason, pending state and outcome. Use the definition's guard to disable the UI.
`useSession()` exposes scenario/reset controls. `useNodeFocus` reports existing-router focus.

`useMountedNode` mounts after commit with component or history-entry lifetime. Retention
ends with the session. Raw access is explicit: `/advanced` exports `useRuntime` and
`useRawNode`. `/internal` contains route selection and the raw session for sibling bindings.
The optional `/effect` entry adds capability lookup for custom route bindings.

Use Expo's `developmentBridge()` or Vite's live/vite equivalent as the provider's `bridge`.
Only one connector type, `Bridge`, is exported. The generic entry never imports the dialler.

Start with [adopting](../../docs/adopting.md), then `src/react.tsx` and `src/route-binding.ts`.
Session replacement unmounts owned nodes; focus cleanup never clears a newer screen.
