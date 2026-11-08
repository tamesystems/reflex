# 0005. Read Expo Router's private action event, pinned

Status: Accepted

## Context

A push the user undoes before it renders (a fast back) leaves the rendered location
unchanged. Every public hook and the container's `state` event see only what a render
committed, so the projection could not tell the push was gone until its 500 ms deadline,
and the core showed a screen the user had already left.

## Decision

`packages/expo/src/router-actions.ts`, and nothing else, listens to Expo Router's private
`actionDispatched` event and reads each accepted action's state with the same function
the hooks use. `expo-router` is pinned to exactly the version
`packages/expo/test/router-actions.test.ts` checks.

## Consequences

- On the web, the core follows an undone push in about 10 ms rather than 500.
- Upgrading `expo-router` means reading those modules again and moving the pin.
- The deadline stays as the backstop for a command the router drops without saying so.
