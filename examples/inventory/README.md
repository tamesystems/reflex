# Inventory example

The Effect core has InventoryApi and SettingsStore ports. Its default host in src/app.ts
supplies only fixtures and is safe for network-guarded headless journeys. The Expo app
can compose the exported root with real services; see [mobile setup](../../apps/mobile/README.md).

Run the local development API with `bun examples/inventory/server.ts` from the root.
INVENTORY_PORT defaults to 8791 (zero asks the OS); INVENTORY_HOST defaults to 127.0.0.1.
It prints one JSON line containing its URL. The Bun server works on Linux, macOS and Windows.

| Request              | Result                                                           |
| -------------------- | ---------------------------------------------------------------- |
| GET /products        | Seeded inventory, including subsequent saved quantities          |
| GET /products/:id    | One product, or JSON 404                                         |
| PUT /products/:id    | JSON `{ "quantity": 12 }`; validated integer in the domain range |
| POST /fail-next-save | The next valid save returns JSON 503, exactly once               |
| POST /reset          | Restore seed products and clear pending failure                  |

Invalid quantities and malformed JSON return JSON 400; bodies over 64 KiB return JSON
413. Unsupported product methods return JSON 405. The API
uses memory, open CORS and no authentication: it is a local example, not a hosted service.
App reset reads current data; only POST /reset reseeds it.

src/http-api.ts implements the port with Effect's fetch client, decoded responses,
typed errors, interruption-driven abort and a four-second deadline. It is not imported
by the fixture host. Device storage lives in apps/mobile. journeys/services.ts is shared
by the guarded headless test and the real browser harness.
