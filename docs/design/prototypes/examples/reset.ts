import { createTestApp, connectJourney } from "@reflex/test"
import app from "./examples/inventory/src/scenarios.ts"
import { InventoryFixture } from "./examples/inventory/src/fixtures.ts"
import { InventoryList } from "./examples/inventory/src/screens.ts"
import { servicesJourney } from "./examples/inventory/journeys/services.ts"

export async function resetAndReacquire() {
  await using initial = await createTestApp(app)
  const next = await initial.reset("empty-inventory")
  const list = await next.focused(InventoryList, { _tag: "ready" })
  await list.actions.OpenSettings()
  // initial and its handles are invalid now. Ownership stays with initial's disposer.
}
export async function fixtureStory() {
  await using session = await createTestApp(app, { scenario: "inventory-with-products" })
  const fixture = await session.node(InventoryFixture)
  await servicesJourney(session, async () => {
    await fixture.actions.FailNextSave()
  })
}
export async function realServiceStory(failNextSave: () => Promise<void>) {
  await using session = await connectJourney(app, { target: "device", scenario: "live-services" })
  await servicesJourney(session, failNextSave)
}
