# 0012. Windows sessions use authenticated, encrypted pipes

Status: Accepted; amends [0007](0007-socket-permissions-are-the-authentication.md)

## Context

Windows has named pipes, not Unix socket files. Node's `net` and Bun's compatible API
accept pipe names but expose no owner SID or custom security descriptor option. Unix
`chmod(0600)` and directory `0700` checks do not establish Windows ACLs.

Microsoft documents that a pipe created with a null security descriptor grants full
control to the creator, SYSTEM and Administrators, and read access to Everyone and
Anonymous. This is not an owner-only boundary. Node/libuv's Windows pipe implementation
uses a null security attributes pointer on creation; Bun's public `node:net` API does
not offer a stronger guarantee. We deliberately do not depend on the runtime's default
DACL, or on whether a particular machine admits another user's duplex connection.

Sources:

- [Microsoft: named pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- [Node: IPC and listen options](https://nodejs.org/api/net.html#ipc-support)
- [libuv Windows pipes](https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c)
- [Microsoft: pipe impersonation requirements](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient)
- [Bun: net connections](https://bun.com/reference/node/net/createConnection)
- [Microsoft: creating a directory with DirectorySecurity](https://learn.microsoft.com/en-us/dotnet/api/system.io.directoryinfo.create?view=netframework-4.8.1)

## Decision

macOS/Linux keep ADR 0007's model unchanged. Windows sessions listen at
`\\.\pipe\reflex-<sha256>`, hashing the lowercase resolved REFLEX_DIR, a NUL, and the
target (`headless` or `device`). Pipes are probed by connecting and disappear when their
last handle closes; no filesystem operation tests or removes a pipe.

A Windows daemon, after acquiring the target lock, generates a fresh 32-byte secret in
`session.auth` or `device.auth`. Clean shutdown/stale cleanup removes it. The separate
`device.token` remains stable across bridge restarts.

Windows PowerShell 5.1 (included with Windows) and .NET enforce/check actual filesystem
ACLs. A newly created REFLEX_DIR is created with a protected DACL granting the current
user inheritable FullControl, without a permissive creation interval. Existing directories
and secrets are checked, never silently made private. Allow ACEs and ownership may name
only the current user, SYSTEM or built-in Administrators. Reparse points and noncanonical
ACLs are refused. Errors, including unavailable PowerShell or an unsupported filesystem,
fail closed. No reliance is placed on Unix mode bits, user-profile defaults or the
location of an arbitrary REFLEX_DIR. Its ancestors must also be trusted against rename
or replacement, as with the Unix directory model.

Before JSON-RPC, both sides prove knowledge of the secret using fresh 32-byte nonces
and role-separated HMAC-SHA256. Subsequent frames use AES-256-GCM with separate keys
for each direction derived from the secret and both nonces, and an implicit increasing
sequence as the nonce. This prevents a squatting/relaying pipe process reading state,
changing commands, reflecting frames or replaying an earlier connection. A relay can
still forward the authorized client's exact traffic or deny service. The secret never
crosses the pipe. No controller request, including shutdown, is admitted before auth.
Handshake time, line length, frame count, frame length, connections and write queues are
bounded in protocol/limits.ts.

CLI and MCP use connectToSession automatically. In-process journeys and stdio retain
their existing wire format. External raw pipe peers use the documented handshake and
frame codec (also exported as authenticateLocal), then ordinary JSON-RPC. Unix raw
peers are unchanged.

## Consequences

Other ordinary Windows users cannot obtain the session secret from storage accepted by
the ACL checks, and cannot read or originate authenticated traffic without it. Processes
running as the developer, SYSTEM and administrators are trusted; this is not a boundary
against them, compromised app code, a hostile filesystem/ancestor, or deliberate secret
sharing. Unauthorized connections can consume bounded resources or squat the pipe name,
so availability against hostile local users is not guaranteed. ACL checks cost a
PowerShell process. Windows SIGTERM kills cannot promise graceful cleanup; protocol
shutdown remains portable and stale locks are reclaimed only after their owner is dead.

The Node-compatible pipe API also exposes no client impersonation-level control.
libuv opens clients without SECURITY_SQOS_PRESENT. Principals with Windows
SeImpersonatePrivilege (including some service accounts), debug/backup privileges, or
an already obtained token for the developer are therefore also trusted: a malicious
server with impersonation privilege can act as a connecting client before an
application handshake. Ordinary different-user processes do not have that privilege;
cryptography is not a boundary against privileged OS token impersonation. Do not run
Reflex on a host with untrusted privileged services, or supply explicit logon credentials
to an untrusted pipe server. External raw clients should request SecurityIdentification
or SecurityAnonymous when their Windows API exposes that option.
