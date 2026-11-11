import { createReflex } from "@reflex/react"
import { createRouteAdapter } from "@reflex/react/advanced"
import { createRouteRegistry } from "@reflex/runtime/advanced"
import { createSessionOwner } from "@reflex/live/advanced"
import { connectBridge } from "@reflex/live"
import { developmentBridge } from "@reflex/live/dev"
import { createTestAppPool } from "@reflex/test"
import { createJourneyClient, type JourneyTransport } from "@reflex/test/advanced"
import { defineService } from "@reflex/effect"
import * as Schema from "effect/Schema"
import app from "./examples/plain/src/app.ts"

// Registry and adapter ports are integration plumbing, not the application-author tier.
export async function registryLifecycle(contract: object) {
  const registry = createRouteRegistry(
    new Map([[contract, async (params: unknown) => ({ params })]]),
  )
  const lease = registry.acquire(contract, "history-entry", {})
  const release = lease.retain()
  await lease.ready
  await lease.retry()
  release()
  await registry.discard("history-entry")
  await registry.dispose()
}
export const HostAdapter = createRouteAdapter(createReflex(app), {
  useLocation: () => ({ key: "host-key", contract: {}, params: {}, navigationType: "POP" }),
})
export async function bridgeLifecycle(setting: string) {
  const owner = createSessionOwner(async () => connectBridge(setting))
  await owner.close()
  // The React Provider owns this lifecycle in the normal host tier.
  const bridge = developmentBridge()
  await bridge?.close()
}
export async function remoteJourney(transport: JourneyTransport) {
  await using journey = createJourneyClient(app, "default", transport)
  await journey.reset("default")
}
export async function pooledJourney() {
  const pool = createTestAppPool()
  try {
    await pool.open(app)
  } finally {
    await pool.disposeAll()
  }
}
export const Metrics = defineService({
  name: "Metrics",
  state: Schema.Number,
  initial: () => 0,
  actions: (a) => ({ Increment: a.reduce({ reducer: (_, n) => n + 1 }) }),
})
