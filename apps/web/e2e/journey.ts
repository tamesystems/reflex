import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { chromium, type Page } from "playwright-core"

const bun = process.env.BUN ?? "bun"
const cliPath = process.env.REFLEX_CLI ?? ""
const run = promisify(execFile)
const reflex = async (...args: string[]) => {
  const { stdout } = await run(bun, [cliPath, "--target", "device", ...args], {
    env: process.env,
    timeout: 20_000,
  })
  return JSON.parse(stdout) as { id: string; name: string; state: { count: number } }
}
const focus = async (name: string) => {
  await reflex("wait", JSON.stringify({ focus: name }))
  const seen = await reflex("ls")
  assert.equal(seen.name, name)
  return seen
}
const count = async (page: Page, value: number) => {
  await page
    .getByText(`Count: ${value}`, { exact: true })
    .waitFor()
    .catch(async (error) => {
      console.error(await page.locator("body").textContent(), await reflex("tree"))
      throw error
    })
  await reflex("wait", JSON.stringify({ match: { count: value } }))
  assert.equal((await reflex("ls")).state.count, value)
}
/** One tool call through `reflex mcp`, as an agent's MCP client would make it. */
const mcpCall = (
  target: "device",
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

const history = async (page: Page) => {
  await page.getByRole("link", { name: "Open detail", exact: true }).click()
  const first = await focus("Detail")
  await reflex("do", "Increment")
  await count(page, 1)
  // Same URL, different history entry; each owns a distinct node and state.
  await page.getByRole("link", { name: "Open detail", exact: true }).click()
  await count(page, 0)
  const second = await focus("Detail")
  assert.notEqual(first.id, second.id)
  await page.goBack()
  await count(page, 1)
  assert.equal((await focus("Detail")).id, first.id)
  await page.goBack()
  await focus("List")
  await assert.rejects(reflex("do", "Increment", "--node", first.id), /not focused/)
  console.log("ok   back changes focus and departed screens refuse actions")
  await page.goForward()
  assert.equal((await focus("Detail")).id, first.id)
  await count(page, 1)
  console.log("ok   forward restores entry identity and state")
}
const journey = async (page: Page) => {
  await page.goto(`http://127.0.0.1:${process.env.PORT}/`)
  await page.getByRole("heading", { name: "List", exact: true }).waitFor()
  await focus("List")
  console.log("ok   CLI inspects the focused list")
  await reflex("do", "Increment")
  await count(page, 1)
  console.log("ok   CLI dispatch updates page")
  await page.getByRole("button", { name: "Add one" }).click()
  await count(page, 2)
  console.log("ok   page click updates CLI")
  await history(page)
  const result = await mcpCall("device", "reflex_dispatch", { action: "Increment" })
  assert.equal(result.isError, false)
  await count(page, 2)
  console.log("ok   MCP reflex_dispatch updates page")
  const previous = await reflex("ls")
  await reflex("reset")
  await count(page, 0)
  assert.notEqual((await focus("Detail")).id, previous.id)
  console.log("ok   reset replaces session and nodes at the current route")
}
const deadline = setTimeout(() => {
  console.error("Journey timed out")
  process.exit(1)
}, 120_000)
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors: string[] = []
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  page.on("pageerror", (error) => errors.push(error.message))
  await journey(page)
  assert.deepEqual(errors, [])
} finally {
  clearTimeout(deadline)
  await browser.close()
}
