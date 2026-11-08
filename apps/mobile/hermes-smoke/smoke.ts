/**
 * Runs the real journey on a real Hermes VM, from a Metro-built bundle.
 * `run.ts` builds it; the last line printed is the verdict.
 */
import "./shims.ts"
import app from "@reflex/example-inventory"
import { ProtocolError } from "@reflex/protocol"

declare const print: (...args: Array<unknown>) => void

const DETAIL_CHARACTERS_MAX = 500

const check = ({
  label,
  passed,
  detail,
}: {
  readonly label: string
  readonly passed: boolean
  readonly detail?: unknown
}) => {
  const shown = passed ? "" : ` ${String(JSON.stringify(detail)).slice(0, DETAIL_CHARACTERS_MAX)}`
  print(`${passed ? "ok  " : "FAIL"} ${label}${shown}`)
  if (!passed) {
    throw new Error(label)
  }
}

const journey = async () => {
  const session = await app.start("inventory-with-products", { sessionId: "journey" })
  const { runtime } = session
  await runtime.wait({ idle: true, focus: "InventoryList", match: { _tag: "ready" } })
  check({ label: "list loaded", passed: true })

  await runtime.dispatch({
    action: "OpenProduct",
    input: { productId: "product-123" },
    await: true,
  })
  await runtime.wait({ idle: true, focus: "InventoryDetail", match: { title: "Blue T-Shirt" } })
  check({ label: "navigated to detail", passed: true })

  const invalid = await runtime
    .dispatch({ action: "SetQuantity", input: { quantity: -1 } })
    .catch((error: unknown) => (error instanceof ProtocolError ? error.code : undefined))
  check({ label: "schema rejects bad input", passed: invalid === -32003, detail: invalid })

  await runtime.dispatch({ action: "SetQuantity", input: { quantity: 12 }, await: true })
  const saved = await runtime.dispatch({ action: "Save", await: true })
  check({ label: "save completed", passed: saved.status === "completed", detail: saved })

  await runtime.dispatch({ action: "GoBack", await: true })
  await runtime.wait({ idle: true, focus: "InventoryList", match: { _tag: "ready" } })
  const listed = JSON.stringify(runtime.inspect().node?.state)
  check({
    label: "list refreshed after back",
    passed: listed.includes('"quantity":12'),
    detail: listed,
  })

  await runtime.dispatch({ action: "OpenSettings", await: true })
  await runtime.wait({ idle: true, focus: "Settings", match: { _tag: "ready" } })
  check({
    label: "secret redacted",
    passed: JSON.stringify(runtime.inspect({ tree: true })).indexOf("secret-fixture-token") < 0,
  })
  await session.dispose()
  check({ label: "session disposed", passed: true })
}

const virtualTime = async () => {
  const session = await app.start("slow-network", { sessionId: "virtual-time" })
  const { runtime } = session
  const { advanceTime } = session
  if (advanceTime === undefined) {
    throw new Error("This scenario runs on virtual time")
  }
  await runtime.wait({ idle: true, focus: "InventoryList", match: { _tag: "ready" } })
  await runtime.dispatch({
    action: "OpenProduct",
    input: { productId: "product-123" },
    await: true,
  })
  await runtime.wait({ idle: true, focus: "InventoryDetail", match: { _tag: "editing" } })

  const timedOut = await runtime.dispatch({ action: "Save" })
  await runtime.wait({ match: { _tag: "saving" } })
  await advanceTime(5000)
  await runtime.wait({ operationId: timedOut.operationId })
  check({
    label: "timeout on virtual time",
    passed: runtime.operation(timedOut.operationId).status === "failed",
  })

  const cancelled = await runtime.dispatch({ action: "Save" })
  await runtime.wait({ match: { _tag: "saving" } })
  await runtime.dispatch({ action: "GoBack", await: true })
  await runtime.wait({ operationId: cancelled.operationId })
  check({
    label: "leaving cancels",
    passed: runtime.operation(cancelled.operationId).status === "cancelled",
  })
  await session.dispose()
}

journey()
  .then(virtualTime)
  .then(() => print("HERMES SMOKE PASSED"))
  .catch((error: unknown) => print(`HERMES SMOKE FAILED: ${String(error).slice(0, 500)}`))
