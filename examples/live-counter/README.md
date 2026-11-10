# Framework-free live counter

A plain Bun process, with no React, React Native, Expo, Effect or store library.

## Responsibilities

`src/app.ts` mounts an application-owned counter store as an ambient `service` node.
`src/serve.ts` owns LiveSessions and serves their controller with connectBridge.

## Does not own

The daemon or transports on the developer side; the CLI starts and stops those.

## Start reading

1. `src/app.ts`: minimal AppHost, mountStore and Increment action.
2. `src/serve.ts`: live session and WebSocket connection lifecycle.
3. `../../test/framework-free.test.ts`: real process/CLI acceptance journey.

## Running

Start `bun run reflex --target device start`, then copy its appSetting:

```sh
REFLEX_BRIDGE='ws://127.0.0.1:8790#<token>' bun examples/live-counter/src/serve.ts
```

PowerShell: set `$env:REFLEX_BRIDGE = 'ws://127.0.0.1:8790#<token>'`, then run the Bun command.
In another terminal, run `bun run reflex --target device tree`, `do Increment`,
`wait '{"name":"Counter","match":{"count":1}}'`, or `reset` with that same prefix.
`ls --schema` lists the ambient action; `tree` includes its state because no screen has focus.
Stop the process with Ctrl+C and run `bun run reflex --target device stop`.

The source uses the standard global WebSocket API, available in Node 22+ too; running
TypeScript directly requires a Node version with TypeScript stripping or a TS loader.
The automated journey runs on Bun on Ubuntu and Windows as part of `bun run check`.

## Important invariants

- Each reset creates a fresh store and changes node handles.
- No focus or Navigation node is required for ambient service actions.
- The bridge daemon runs outside bun test, on its own event loop.
