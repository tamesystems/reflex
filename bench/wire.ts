/** What a request costs through the protocol, and what events cost to log and encode. */
import { defineApp, defineCapability, mount, Registry } from "@reflex/effect"
import { type RuntimeEvent, toNodeId } from "@reflex/protocol"
import { createEventEncoder, createLoopbackClient } from "@reflex/rpc"
import { createController } from "@reflex/runtime"
import { EventLog } from "../packages/runtime/src/event-log.ts"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import inventory from "../examples/inventory/src/app.ts"

const REQUEST_COUNT = 2_000
const FRAME_COUNT = 200
const FRAME_CHARACTERS = 1024 * 1024
const ROW_COUNT = 25_000
const ROW_RUN_COUNT = 20

const measure = async (label: string, count: number, run: () => Promise<void>): Promise<void> => {
  // Once to warm up, as the first run of anything is mostly the compiler.
  await run()
  const startMs = performance.now()
  await run()
  const elapsedMs = performance.now() - startMs
  console.log(`${label}: ${(elapsedMs / count).toFixed(3)} ms each, ${count} runs`)
}

const controller = await createController(inventory)
const client = createLoopbackClient(controller)

await measure("inspect over loopback", REQUEST_COUNT, async () => {
  for (let index = 0; index < REQUEST_COUNT; index++) {
    await client.request("app.inspect", {})
  }
})

const encode = createEventEncoder()
const text = "x".repeat(FRAME_CHARACTERS)
const largeEvent = (sequence: number): RuntimeEvent => ({
  type: "state.changed",
  sessionId: "bench",
  sequence,
  revision: sequence,
  nodeId: toNodeId("n"),
  state: { text },
})
const events = Array.from({ length: FRAME_COUNT }, (_, index) => largeEvent(index))
await measure("encoding a 1 MiB event", FRAME_COUNT, async () => {
  for (const event of events) {
    encode(event)
  }
})

await measure("logging a 1 MiB event", FRAME_COUNT, async () => {
  const log = new EventLog()
  for (const event of events) {
    log.append(event)
  }
})

// Rows are the case to watch: every value is a step for all that walks them.
const Rows = defineCapability({
  name: "Rows",
  state: Schema.Struct({
    version: Schema.Int,
    rows: Schema.Array(Schema.Struct({ id: Schema.String, n: Schema.Int, on: Schema.Boolean })),
  }),
  actions: (action) => ({
    Touch: action({
      handler: (_, state) =>
        state.update((current) => ({ ...current, version: current.version + 1 })),
    }),
  }),
})
const rows = Array.from({ length: ROW_COUNT }, (_, n) => ({ id: `row-${n}`, n, on: n % 2 === 0 }))
const rowsApp = defineApp({
  name: "rows",
  defaultScenario: "default",
  root: Layer.effectDiscard(
    Effect.gen(function* () {
      const node = yield* mount(Rows, { version: 0, rows })
      const registry = yield* Registry
      registry.setFocus(node.id)
    }),
  ),
  scenarios: { default: { layer: Layer.empty } },
})
const rowsController = await createController(rowsApp)
const rowsClient = createLoopbackClient(rowsController)
await rowsClient.request("app.subscribe", {})
await measure(`one change to ${ROW_COUNT} rows, to a subscriber`, ROW_RUN_COUNT, async () => {
  for (let index = 0; index < ROW_RUN_COUNT; index++) {
    await rowsClient.request("app.dispatch", { action: "Touch", await: true })
  }
})
rowsClient.close()
await rowsController.close()

client.close()
await controller.close()
