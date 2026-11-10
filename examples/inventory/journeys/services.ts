/** One behavior definition, run by @reflex/test and by the browser's real CLI harness. */
export interface ServicesJourney {
  do(
    action: string,
    input?: Record<string, unknown>,
  ): Promise<{
    readonly status: string
    readonly error?: { readonly tag: string; readonly defect: boolean }
  }>
  precondition(screen: string, match: Record<string, unknown>): Promise<void>
  failNextSave(): Promise<void>
}

export const servicesJourney = async (app: ServicesJourney): Promise<void> => {
  await app.precondition("InventoryList", {
    _tag: "ready",
    products: [{ id: "product-123", quantity: 5 }, {}, {}],
  })
  await app.do("OpenProduct", { productId: "product-123" })
  await app.precondition("InventoryDetail", { _tag: "editing", title: "Blue T-Shirt", quantity: 5 })
  await app.do("SetQuantity", { quantity: 12 })
  if ((await app.do("Save")).status !== "completed") {
    throw new Error("Save did not complete")
  }
  await app.do("GoBack")
  await app.precondition("InventoryList", {
    products: [{ id: "product-123", quantity: 12 }, {}, {}],
  })
  await app.do("OpenProduct", { productId: "product-123" })
  await app.precondition("InventoryDetail", { quantity: 12, error: null })
  await app.do("SetQuantity", { quantity: 19 })
  await app.failNextSave()
  const failed = await app.do("Save")
  if (
    failed.status !== "failed" ||
    failed.error?.tag !== "ApiError" ||
    failed.error.defect !== false
  ) {
    throw new Error("A server error must be a typed ApiError, not a defect")
  }
  await app.precondition("InventoryDetail", {
    _tag: "editing",
    quantity: 19,
    error: "Server error",
  })
  await app.do("GoBack")
  await app.precondition("InventoryList", { products: [{ quantity: 12 }, {}, {}] })
  await app.do("OpenSettings")
  await app.precondition("Settings", { _tag: "ready" })
  await app.do("SetLowStockThreshold", { threshold: 3 })
  await app.do("GoBack")
  await app.precondition("InventoryList", { lowStockThreshold: 3 })
  await app.do("OpenSettings")
  await app.precondition("Settings", { lowStockThreshold: 3 })
}
