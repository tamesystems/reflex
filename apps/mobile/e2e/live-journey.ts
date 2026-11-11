/**
 * The same CLI commands, against the app live in Chrome through the bridge and against a
 * headless session: each must answer the same, and the page must show each change. Then
 * the other way round: a tap in the page is what the CLI sees next.
 */
import { execFile, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { chromium, type Page } from "playwright-core"

const STEP_TIMEOUT_MS = 8_000
const JOURNEY_TIMEOUT_MS = 240_000
const METRO_BUNDLE_TIMEOUT_MS = 150_000
const DIAGNOSTIC_CHARACTERS_MAX = 600
const INVENTORY_APP = fileURLToPath(
  new URL("../../../examples/inventory/src/scenarios.ts", import.meta.url).href,
)

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set`)
  }
  return value
}

const base = `http://localhost:${required("PORT")}`
const cliPath = required("REFLEX_CLI")
const bun = required("BUN")
const run = promisify(execFile)

type Target = "device" | "headless"

const reflex = async (target: Target, ...args: ReadonlyArray<string>): Promise<unknown> => {
  const { stdout } = await run(bun, [cliPath, "--target", target, ...args], {
    env: process.env,
    timeout: STEP_TIMEOUT_MS * 3,
  })
  return JSON.parse(stdout)
}

/** Ids name their session, which differs between any two; the rest must not. */
const normalized = (value: unknown): string =>
  JSON.stringify(
    value,
    (key, item: unknown) =>
      key === "scenarios" && Array.isArray(item)
        ? // These scenarios belong only to the device host and startup-failure probe.
          item.filter(
            (scenario: { name: string }) =>
              !["device-services", "e2e-late-failure"].includes(scenario.name),
          )
        : item,
    2,
  ).replace(/\b(?:session|app)-[0-9a-z]{8}-\d+\b/g, "<session>")

const failures: Array<string> = []
const pageErrors: Array<string> = []

const check = (label: string, passed: boolean, detail = ""): void => {
  console.log(`${passed ? "ok  " : "FAIL"} ${label}${passed ? "" : ` ${detail}`}`)
  if (!passed) {
    failures.push(label)
  }
}

const visible = async (page: Page, text: string): Promise<boolean> => {
  try {
    await page.getByText(text, { exact: false }).last().waitFor({ state: "visible" })
    return true
  } catch {
    // Not appearing in time is what the caller is asking about.
    return false
  }
}

const pathOf = (page: Page): string => new URL(page.url()).pathname

interface Step {
  readonly args: ReadonlyArray<string>
  /** What the page must then show, and where. */
  readonly shows: string
  readonly path: string
}

const STEPS: ReadonlyArray<Step> = [
  { args: ["ls"], shows: "Blue T-Shirt", path: "/" },
  {
    args: ["do", "OpenProduct", '{"productId":"product-123"}'],
    shows: "Quantity: 5",
    path: "/inventory/product-123",
  },
  {
    args: ["do", "SetQuantity", '{"quantity":12}'],
    shows: "Quantity: 12",
    path: "/inventory/product-123",
  },
  { args: ["do", "Save"], shows: "Quantity: 12", path: "/inventory/product-123" },
  { args: ["ls"], shows: "Quantity: 12", path: "/inventory/product-123" },
  { args: ["do", "GoBack"], shows: "Grey Hoodie", path: "/" },
  { args: ["reset"], shows: "Canvas Tote", path: "/" },
  { args: ["ls"], shows: "Blue T-Shirt", path: "/" },
]

const journey = async (page: Page): Promise<void> => {
  check("the app connects to the bridge", (await reflex("device", "status")) !== null)
  await reflex("headless", "start", INVENTORY_APP)
  for (const step of STEPS) {
    const label = `reflex ${step.args.join(" ")}`
    const live = await reflex("device", ...step.args)
    const headless = await reflex("headless", ...step.args)
    check(
      `${label}: answers as a headless session does`,
      normalized(live) === normalized(headless),
      `\nlive:     ${normalized(live).slice(0, DIAGNOSTIC_CHARACTERS_MAX)}\nheadless: ${normalized(headless).slice(0, DIAGNOSTIC_CHARACTERS_MAX)}`,
    )
    const shown = (await visible(page, step.shows)) && pathOf(page) === step.path
    check(`${label}: the page shows it`, shown, `at ${pathOf(page)}`)
  }

  await page.getByText("Blue T-Shirt").click()
  check("a tap opens the product", await visible(page, "Quantity: 5"))
  await page.getByText("Increment").click()
  check("a tap changes it", await visible(page, "Quantity: 6"))
  await reflex("device", "wait", '{"match":{"quantity":6}}')
  const seen = (await reflex("device", "ls")) as {
    readonly name?: string
    readonly state?: { readonly quantity?: number }
  }
  check(
    "the CLI sees what the tap did",
    seen.name === "InventoryDetail" && seen.state?.quantity === 6,
    normalized(seen).slice(0, DIAGNOSTIC_CHARACTERS_MAX),
  )

  // An agent over MCP drives the same live app, and is told what the CLI is told.
  const viaMcp = await mcpCall("device", "reflex_dispatch", { action: "Increment" })
  check("an MCP tool call reaches the live app", await visible(page, "Quantity: 7"))
  const listed = await reflex("device", "ls", "--schema")
  const inspected = await mcpCall("device", "reflex_inspect", {})
  check(
    "MCP answers as the CLI does",
    viaMcp.isError === false && normalized(inspected.structuredContent) === normalized(listed),
    normalized(inspected).slice(0, DIAGNOSTIC_CHARACTERS_MAX),
  )
}

/** One tool call through `reflex mcp`, as an agent's MCP client would make it. */
const mcpCall = (
  target: Target,
  name: string,
  args: unknown,
): Promise<{ readonly isError?: boolean; readonly structuredContent?: unknown }> =>
  new Promise((resolve, reject) => {
    const child = spawn(bun, [cliPath, "--target", target, "mcp"], { env: process.env })
    let output = ""
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", () => {
      const replies = output
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> })
        .filter(({ id }) => id === 1)
      resolve(replies[0]?.result ?? {})
    })
    const initialize = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e", version: "1" },
      },
    }
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }
    child.stdin.end(`${JSON.stringify(initialize)}\n${JSON.stringify(call)}\n`)
  })

const runAll = async (): Promise<void> => {
  const browser = await chromium.launch({ channel: "chrome", headless: true })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(STEP_TIMEOUT_MS)
    page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 500)))
    page.on("console", (message) => {
      if (message.type() === "error") {
        pageErrors.push(message.text().slice(0, 500))
      }
      if (process.env.REFLEX_LIVE_VERBOSE === "1") {
        console.log(`  page ${message.type()}: ${message.text().slice(0, 300)}`)
      }
    })
    await page.goto(`${base}/`, { timeout: METRO_BUNDLE_TIMEOUT_MS })
    if (process.env.REFLEX_PLAIN === "1") {
      await page
        .getByText("Count: 0", { exact: true })
        .waitFor({ timeout: METRO_BUNDLE_TIMEOUT_MS })
      await reflex("device", "do", "Add", '{"by":4}')
      check("CLI drives the plain screen through the bridge", await visible(page, "Count: 4"))
      await page.getByText("Add one", { exact: true }).click()
      await page.getByText("Count: 5", { exact: true }).waitFor()
      check("plain UI writes reach the CLI", await visible(page, "Count: 5"))
      const result = await mcpCall("device", "reflex_dispatch", { action: "Add", input: { by: 2 } })
      check(
        "MCP drives the plain screen",
        result.isError === false && (await visible(page, "Count: 7")),
      )
      await reflex("device", "reset")
      check("reset replaces the plain screen's session", await visible(page, "Count: 0"))
    } else {
      await page.getByText("Blue T-Shirt").first().waitFor({ timeout: METRO_BUNDLE_TIMEOUT_MS })
      check("the app renders", await visible(page, "Blue T-Shirt"))
      await journey(page)
    }
  } finally {
    await browser.close()
  }
}

const deadline = setTimeout(() => {
  console.error(`The live journey did not finish in ${JOURNEY_TIMEOUT_MS}ms`)
  process.exit(1)
}, JOURNEY_TIMEOUT_MS)

runAll()
  .then(() => {
    clearTimeout(deadline)
    console.log("browser errors:", pageErrors.length > 0 ? pageErrors : "none")
    process.exit(failures.length > 0 || pageErrors.length > 0 ? 1 : 0)
  })
  .catch((error: unknown) => {
    console.error(String(error).slice(0, DIAGNOSTIC_CHARACTERS_MAX))
    console.error("browser errors:", pageErrors)
    process.exit(1)
  })
