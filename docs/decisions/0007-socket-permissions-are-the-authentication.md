# 0007. Socket permissions are the authentication

Status: Accepted

## Context

A session can do anything its app's actions can. It runs on a developer's machine, for
that developer's tools. Tokens or TLS on a local socket would add setup without
protecting against anyone who could not already read the developer's files.

## Decision

Sessions listen only on Unix sockets, created `0600` in a directory that must be private
to its owner (`0700`); the daemon refuses to start otherwise. There is no other
authentication for local sessions.

## Consequences

- Anyone who can open the socket can drive the app; anyone else cannot reach it at all.
- Windows named pipes are not implemented.
- The device bridge, which listens on a TCP port, needs a token
  ([ADR 0008](0008-the-device-dials-out.md)).
