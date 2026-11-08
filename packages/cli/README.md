# @reflex/cli

The `reflex` command: background sessions, the device bridge, and the MCP server. Every
command reaches a session the same way, through its socket, so the CLI holds no app state.

## Responsibilities

- Start, find and stop session daemons, one per target per `REFLEX_DIR`.
- Run each command once, in `commands.ts`, for both the terminal and MCP.
- Accept apps on the device bridge and admit them by token.
- Serve the commands as MCP tools.

## Does not own

- What a session does with a request: that is the controller's (`@reflex/runtime`, or the
  app's own through the bridge).
- The wire format: `@reflex/rpc` and `@reflex/protocol`.

## Start reading

1. `cli.ts`: argument parsing, and which command runs.
2. `commands.ts`: what each command does over a client.
3. `session.ts`: `start` spawns a daemon and waits until it answers; `serve` runs one.
4. `bridge-server.ts`, then `mcp.ts`.

## Sessions

`reflex start <module>` spawns `reflex serve <module> --daemon` and returns once the daemon
answers on its socket, or reports why it failed. The module must export an `AppHost` as
`default` or `app`.

- **Targets.** `--target device` (or `REFLEX_TARGET=device`) selects the device session's
  files instead of the headless one's, so both can run at once. For the device target,
  `start` takes `--host` (default `127.0.0.1`) and `--port` (default 8790) instead of a module.
- **One per directory.** The lock file holds the daemon's pid and is created atomically;
  a second start is refused. A stale lock is reclaimed only once its owner is gone.
- **Startup budget.** `REFLEX_START_TIMEOUT_MS` (default 10 s, at most 10 minutes) covers the
  whole start of a headless session, module loading included, and each reset's new
  session. It does not reach apps behind the bridge, whose starts use the runtime's 30 s
  default.
- **Logs.** A daemon logs to `<target>.log.<pid>` in the session directory, up to 1 MiB
  over its lifetime, with room reserved for the reason it failed, and removes the file after
  a clean run. A stdio session uses the same budget on stderr.
- **Stopping.** `reflex stop` asks over the socket and never signals a process, because a
  recorded pid may have been reused. A hung session must be killed by hand.
- **stdio.** `reflex serve --stdio` ends when stdin closes, once requests in flight are
  answered (up to 5 s). Losing stdout, or a peer that lets 32 MiB of replies queue, ends it
  at once. Either way the app is disposed.
- **`reflex watch`** exits non-zero whenever its session goes away, a clean stop included:
  it cannot tell the two apart.

## Windows sessions and raw peers

On Windows the endpoint is `\\.\pipe\reflex-<sha256>`: hash the lowercase resolved
REFLEX_DIR, a NUL, then `headless` or `device`. `loadConfig` exposes `socketPath` and
`authPath`. There is no `.sock` file. The daemon rotates `<target>.auth` after taking the
lock. Windows PowerShell 5.1 checks directory/file ACLs; mode bits do not protect secrets.
Existing storage granting another ordinary principal access is refused. See
[ADR 0012](../../docs/decisions/0012-windows-sessions-use-authenticated-pipes.md).
CLI, MCP and remote journeys using `connectToSession` authenticate automatically.
`connectSocket(path, undefined, secret)` handles the Windows handshake and frame codec.
`serve --stdio` and Unix sockets continue speaking plain NDJSON.

A raw Windows peer reads the hex secret from authPath and opens the pipe. Before JSON-RPC:

1. Client sends a random 32-byte nonce as 64 lowercase hex characters plus LF.
2. Server sends its own nonce, a space, and HMAC-SHA256(secret-as-UTF8,
   `reflex-local-v1:server:<clientNonce>:<serverNonce>`) as hex plus LF.
3. After checking that proof, client sends the corresponding `client` role proof plus LF.
4. Server checks and replies `ok` plus LF. Both sides now use encrypted NDJSON frames.

Each direction derives its 32-byte AES key using the same HMAC with role `key-client`
or `key-server`. Each JSON-RPC line is encrypted with AES-256-GCM; its 12-byte IV is
zero-filled with the direction's zero-based sequence in the last four bytes, big endian.
Send base64(ciphertext concatenated with the 16-byte authentication tag), then LF.
Sequence increases for every frame; reconnect before 2^32 frames. Both fresh nonces make
keys unique per connection. Invalid proofs/frames close the connection. Handshakes get
5 seconds and 256 characters per line. Protocol limits also bound encrypted frames.
The exported `authenticateLocal(socket, secret, false)` returns `{ encode, decode }`
and pauses the socket; attach a bounded reader, then resume. This helper also supports
raw peers that build their own JSON-RPC envelopes. Never send the secret on the wire.

## The device bridge

`reflex --target device start` prints the setting an app needs:

```json
{
  "target": "device",
  "listening": "ws://127.0.0.1:8790",
  "appSetting": "ws://127.0.0.1:8790#<token>",
  "androidEmulatorSetting": "ws://10.0.2.2:8790#<token>",
  "tokenFile": ".../.reflex/device.token"
}
```

- An app must send a hello with the token within 5 s. A wrong token or protocol version
  closes the connection with a code the app treats as final.
- At most 32 connections may be waiting to say hello.
- The newest app to connect is driven; the one it replaced is told so.
- A request with no app connected waits `REFLEX_APP_WAIT_MS` (default 15 s) for one.
- `--host 0.0.0.0` exposes plain `ws://` to the network; use it only where you trust the
  network. An IPv6 host is printed in brackets, and the emulator setting only when the
  emulator can reach it.

## MCP

`reflex mcp` serves MCP over stdio. With Claude Code:

```console
$ claude mcp add reflex -- bun run /path/to/reflex/packages/cli/src/cli.ts mcp
```

| Tool                  | CLI command                                             |
| --------------------- | ------------------------------------------------------- |
| `reflex_status`       | `reflex status`                                         |
| `reflex_inspect`      | `reflex ls --schema`, or one node by `name` or `nodeId` |
| `reflex_tree`         | `reflex tree`                                           |
| `reflex_dispatch`     | `reflex do`                                             |
| `reflex_wait`         | `reflex wait`                                           |
| `reflex_reset`        | `reflex reset`                                          |
| `reflex_sample`       | `reflex sample`                                         |
| `reflex_advance_time` | `reflex advance`                                        |

- Every tool takes `target: "headless" | "device"`, defaulting to the server's own.
  Sessions are still started with `reflex start`.
- Arguments are all checked before a call connects. A bad argument, a refusal from the
  session, or an action that fails is a tool error (`isError`) with the session's detail;
  an unknown tool or method is a protocol error.
- `reflex_dispatch` and `reflex_reset` are marked destructive: a client with these tools can
  do whatever the app's actions can. The marks are hints; the session is the authority.
- Only tools are served. Protocol versions 2024-11-05 to 2025-11-25 are accepted, with
  `structuredContent` from 2025-06-18. At most 16 calls run at once.

## Important invariants

- A command's behavior lives in `commands.ts` only; the CLI and MCP must not diverge.
- Every argument is checked before anything is sent: an action must not run on a bad
  command line.
- Stdout belongs to the protocol in `serve --stdio` and `mcp`; logging goes to stderr.

## Related

[ADR 0007](../../docs/decisions/0007-socket-permissions-are-the-authentication.md),
[ADR 0012](../../docs/decisions/0012-windows-sessions-use-authenticated-pipes.md),
[ADR 0008](../../docs/decisions/0008-the-device-dials-out.md),
[ADR 0009](../../docs/decisions/0009-mcp-reuses-the-cli.md).
