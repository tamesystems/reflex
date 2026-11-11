# Inventory on Expo

Offline production services work with no server: `bun run start`. The same inventory capabilities
can use a real local API and persistent settings in development.

From the repository root, in separate terminals:

```sh
bun examples/inventory/server.ts
bun run reflex --target device start
```

Then from this directory (substitute the bridge setting printed above):

```sh
EXPO_PUBLIC_INVENTORY_API=http://127.0.0.1:8791 EXPO_PUBLIC_REFLEX_BRIDGE='ws://127.0.0.1:8790#<token>' bun run start
```

Open web with `w`. Restart Metro when changing public environment variables. In PowerShell
set `$env:EXPO_PUBLIC_INVENTORY_API = 'http://127.0.0.1:8791'` and the bridge variable
before `bun run start`.

For an Android emulator use `http://10.0.2.2:8791` and the bridge's printed
androidEmulatorSetting. Start the API with INVENTORY_HOST=0.0.0.0 to accept emulator or
LAN connections. A physical device needs the host's LAN address for both services.
The API is unauthenticated development tooling; use a trusted local network.

With the API setting, `device-services` is selected initially and appears in `reflex
--target device status`. `reflex --target device reset` re-reads server inventory and
AsyncStorage settings without erasing either. The `REFLEX_E2E=1` provider additionally installs testScenarios;
`reset inventory-with-products` returns to fixtures there; `reset device-services` returns to real services. Without the setting the
device scenario uses safe offline services. Production ignores the setting.

The threshold uses AsyncStorage 2.2.0 (SDK 58's bundled version), backed by localStorage
on web. No credentials are stored. The API keeps data in memory until stopped; its
POST /reset explicitly restores seed inventory. Protocol reset never calls it.

`bun run e2e:services` starts an out-of-process API on an OS-chosen port, an external
bridge daemon, Metro and Chrome, then runs the shared fixture/live journey. It checks
save errors, server persistence and settings across reset and reload. CI runs it on
Ubuntu and Windows. Native device coverage is still a roadmap item.
