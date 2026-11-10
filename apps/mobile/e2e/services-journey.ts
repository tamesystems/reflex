import { isRecord } from "@reflex/protocol"
import { createJourneyClient } from "@reflex/test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { chromium } from "playwright-core"
import { servicesJourney } from "../../../examples/inventory/journeys/services.ts"

const run = promisify(execFile)
const api = process.env.EXPO_PUBLIC_INVENTORY_API
assert(api)
const reflex = async (...args: string[]) => {
  const command = [process.env.REFLEX_CLI ?? "", "--target", "device", ...args]
  // A deliberately failed Save exits nonzero but still returns its typed operation JSON.
  const { stdout } = await run(process.env.BUN ?? "bun", command, {
    env: process.env,
    timeout: 30_000,
  }).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      error.stdout.trim().startsWith("{")
    ) {
      return { stdout: error.stdout }
    }
    throw error
  })
  return JSON.parse(stdout)
}

const browser = await chromium.launch({ channel: "chrome", headless: true })
try {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error(message.text())
    }
  })
  await page.goto(`http://localhost:${process.env.PORT}/`, { timeout: 150_000 })
  await page.getByText("Blue T-Shirt").first().waitFor({ timeout: 150_000 })
  const status = await reflex("status")
  assert.equal(status.scenario, "live-services")
  const journey = createJourneyClient({
    inspect: async (name) => {
      const { nodes, focus } = await reflex("tree")
      const node = nodes.find((node: { readonly name: string; readonly id: string }) =>
        name === undefined ? node.id === focus : node.name === name,
      )
      assert(node, `Missing node ${name}`)
      return node
    },
    dispatch: async (nodeId, action, input) =>
      (
        await reflex(
          "do",
          action,
          ...(input === undefined ? [] : [JSON.stringify(input)]),
          "--node",
          nodeId,
        )
      ).operation,
    wait: async (screen, match) => {
      await reflex(
        "wait",
        JSON.stringify({ focus: screen, ...(match === undefined ? {} : { match }) }),
      )
      const seen = await reflex("ls")
      assert.equal(seen.name, screen)
      if (screen === "InventoryDetail" && isRecord(match)) {
        if (typeof match.quantity === "number") {
          await page.getByText(`Quantity: ${match.quantity}`, { exact: true }).waitFor()
        }
        if (typeof match.error === "string") {
          await page.getByText(match.error, { exact: true }).waitFor()
        }
      }
      console.log(`ok ${screen}: ${JSON.stringify(match)}`)
    },
  })
  await servicesJourney(journey, async () => {
    assert((await fetch(`${api}/fail-next-save`, { method: "POST" })).ok)
  })
  const saved = await fetch(`${api}/products/product-123`).then((response) => response.json())
  assert.equal(saved.quantity, 12)
  for (const restart of [
    async () => {
      await reflex("reset")
    },
    async () => {
      await reflex("do", "GoBack")
      await page.getByText("Blue T-Shirt").first().waitFor()
      await page.reload()
      await page.getByText("Blue T-Shirt").first().waitFor({ timeout: 150_000 })
    },
  ]) {
    await restart()
    console.log("ok restarted real-services session")
    await reflex(
      "wait",
      JSON.stringify({
        focus: "InventoryList",
        match: {
          _tag: "ready",
          lowStockThreshold: 3,
          products: [{ id: "product-123", quantity: 12 }, {}, {}],
        },
      }),
    )
    await reflex("do", "OpenSettings")
    await reflex("wait", JSON.stringify({ focus: "Settings", match: { lowStockThreshold: 3 } }))
    await page.getByText("Low stock below: 3", { exact: true }).waitFor()
  }
  await reflex("reset", "inventory-with-products")
  await reflex(
    "wait",
    JSON.stringify({
      focus: "InventoryList",
      match: { lowStockThreshold: 10, products: [{ quantity: 5 }, {}, {}] },
    }),
  )
  await reflex("reset", "live-services")
  await reflex(
    "wait",
    JSON.stringify({
      focus: "InventoryList",
      match: { lowStockThreshold: 3, products: [{ quantity: 12 }, {}, {}] },
    }),
  )
  assert.deepEqual(errors, [])
  console.log(
    "ok shared services journey; HTTP persistence and AsyncStorage survive reset and reload",
  )
} finally {
  await browser.close()
}
