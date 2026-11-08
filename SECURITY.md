# Security

Reflex is development tooling. Its trust model:

- **Sessions** listen on a Unix socket readable only by their owner (`0600`, in a
  directory that must be `0700`). Anyone who can open it can drive the app.
- **The device bridge** listens on loopback unless `--host` says otherwise, and admits an
  app only with the 32-byte token in `.reflex/device.token`. Traffic is plain `ws://`:
  binding to a network interface exposes it to that network. Apps must load the bridge
  only in development builds, behind `__DEV__`, as `apps/mobile/app/_layout.tsx` does;
  production builds then contain neither the bridge nor the token.
- **The MCP server** runs only when started, over stdio, and opens no listener. A client
  given its tools can run any action the app exposes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/tamesystems/reflex/security/advisories/new)
rather than in a public issue.
