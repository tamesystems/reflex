import app from "../src/app.ts"
import { reflex } from "../src/routes.ts"
const { useSession, useService, Provider } = reflex
import type { ComponentProps } from "react"

export const useContracts = () => {
  const feature = reflex.from(InventoryDetailScreen)
  const controls = useSession()
  void controls.reset("production")
  // @ts-expect-error Session resets derive scenario names from the app value.
  void controls.reset("missing-scenario")
  const props: ComponentProps<typeof Provider> = {
    children: null,
    // @ts-expect-error Provider scenarios derive from the app.
    scenario: "missing-scenario",
  }
  void props
  const save = feature.useAction("Save")
  const set = feature.useAction("SetQuantity")
  void save.run()
  void set.run({ quantity: 3 })
  // @ts-expect-error Save takes no input.
  void save.run({ quantity: 1 })
  // @ts-expect-error Input is required.
  void set.run()
  // @ts-expect-error Input types derive from the definition.
  void set.run({ quantity: "3" })
  // @ts-expect-error Unknown action.
  feature.useAction("Missing")
}

import { createReflexExpo } from "@reflex/expo"
import {
  InventoryDetail as InventoryDetailScreen,
  InventoryList as InventoryListScreen,
} from "@reflex/example-inventory/screens.ts"
import { InventoryFixture } from "@reflex/example-inventory/fixtures.ts"
import { useScreen } from "../src/routes.ts"
// @ts-expect-error A bound URL registration is total over the app's screens.
createReflexExpo(app, { InventoryList: "/" })
export const useBoundContracts = () => {
  const view = useScreen(InventoryDetailScreen)
  if (view.status === "ready") {
    void view.actions.SetQuantity.run({ quantity: 1 })
    // @ts-expect-error Inputs flow from implementation through the contract-only hook.
    void view.actions.SetQuantity.run({ quantity: "1" })
  }
  useScreen(InventoryListScreen)
  // @ts-expect-error Fixtures are scenario-scoped, not production services.
  useService(InventoryFixture)
}
