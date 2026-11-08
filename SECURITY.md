# Security

Reflex is development tooling. Its trust model:

- **macOS/Linux sessions** listen on a Unix socket readable only by their owner (`0600`, in a
  directory that must be `0700`). Anyone who can open it can drive the app.
- **Windows sessions** use mutually authenticated, encrypted named pipes. A fresh
  32-byte session secret is stored in REFLEX_DIR with a checked ACL allowing only the
  current user, SYSTEM and Administrators. Existing shared storage is refused, wherever
  REFLEX_DIR is located; user-profile placement alone is not a guarantee. Trusted
  ancestors are required. Other users cannot read or originate authenticated frames
  without the secret; they may deny service. Same-user processes, administrators and
  SYSTEM, and principals with OS impersonation/debug/backup privileges are trusted.
  The Node-compatible API cannot set a client impersonation level; authentication
  does not contain a privileged malicious pipe server. See [ADR 0012](docs/decisions/0012-windows-sessions-use-authenticated-pipes.md)
  for the exact ACL, handshake, encryption and threat model. Windows mode bits are not
  used as access control.
- **The device bridge** listens on loopback unless `--host` says otherwise, and admits an
  app only with the 32-byte token in `.reflex/device.token`. Traffic is plain `ws://`:
  binding to a network interface exposes it to that network. Apps must load the bridge
  only in development builds, behind `__DEV__`, as `apps/mobile/app/_layout.tsx` does;
  production builds then contain neither the bridge nor the token.
- **The MCP server** runs only when started, over stdio, and opens no listener. A client
  given its tools can run any action the app exposes, unless the server was started with
  a narrower `--access`.
- **Access policies.** A connection can be limited to observing, or to named actions
  (ADR 0013). Sessions enforce a connection's `access` option themselves. The CLI's
  `--access` and the MCP server's are guards for the process that runs them, not
  boundaries: anything that can open the session's socket can connect with full control.
  To hold an agent to a policy, give it the MCP server and not a shell.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/tamesystems/reflex/security/advisories/new)
rather than in a public issue.
