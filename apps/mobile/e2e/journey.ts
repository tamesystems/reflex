/**
 * The exported web app in headless Chrome. Each scenario waits on the core and
 * the page, never on a duration, so a pass means the state was really reached.
 */
import { type Browser, chromium, type Page } from "playwright-core"

interface Bridge {
  readonly runtime: {
    dispatch(params: unknown): Promise<{ readonly status: string }>
    stateOf(name: string): {
      readonly stack: ReadonlyArray<{ readonly route: string; readonly nodeId: string }>
    }
    wait(params: unknown): Promise<unknown>
  }
  readonly router: {
    push(href: unknown): void
    back(): void
    setParams(params: Record<string, string>): void
  }
  readonly setScenario: (scenario: string) => void
  readonly shownToken: () => string | null
}

declare global {
  var __reflex: Bridge
  var __finishOld: () => void
  var __failLateStart: () => void
}

const STEP_TIMEOUT_MS = 4_000
const SCENARIOS_TIMEOUT_MS = 120_000

const parsePort = (value: string | undefined): number => {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a TCP port")
  }
  return port
}

const base = `http://localhost:${parsePort(process.env.PORT)}`

/** Enough to read, however many a broken page throws. */
const PAGE_ERRORS_MAX = 50
const DIAGNOSTIC_CHARACTERS_MAX = 500

const failures: Array<string> = []
const pageErrors: Array<string> = []

const recordPageError = (text: string): void => {
  if (pageErrors.length < PAGE_ERRORS_MAX) {
    pageErrors.push(text.slice(0, DIAGNOSTIC_CHARACTERS_MAX))
  }
}

const check = ({
  label,
  passed,
  detail = "",
}: {
  readonly label: string
  readonly passed: boolean
  readonly detail?: string
}): void => {
  console.log(`${passed ? "ok  " : "FAIL"} ${label}${passed ? "" : ` ${detail}`}`)
  if (!passed) {
    failures.push(label)
  }
}

const open = async (browser: Browser, url: string): Promise<Page> => {
  const page = await browser.newPage()
  page.setDefaultTimeout(STEP_TIMEOUT_MS)
  page.on("pageerror", (error) => recordPageError(`pageerror: ${error.message}`))
  page.on("console", (message) => {
    if (message.type() === "error") {
      recordPageError(`console: ${message.text()}`)
    }
  })
  await page.goto(base + url)
  return page
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

const routes = (page: Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(() => __reflex.runtime.stateOf("Navigation").stack.map(({ route }) => route))

const coreReady = (page: Page) => page.waitForFunction(() => globalThis.__reflex !== undefined)

/** No operation running, and the router has had two frames to react. */
const settled = (page: Page) =>
  page.evaluate(async () => {
    await __reflex.runtime.wait({ idle: true })
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })

const untilDepth = async (page: Page, depth: number): Promise<void> => {
  await page.waitForFunction(
    (expected) => __reflex.runtime.stateOf("Navigation").stack.length === expected,
    depth,
  )
  await settled(page)
}

const dispatch = (page: Page, ...actions: ReadonlyArray<unknown>) =>
  page.evaluate(
    (list) =>
      Promise.all(
        list.map((params) =>
          __reflex.runtime.dispatch({ ...(params as object), await: true }).then((o) => o.status),
        ),
      ),
    actions,
  )

const detail = (productId: string) => ({
  action: "Navigate",
  input: { route: "InventoryDetail", params: { productId } },
})

const click = (page: Page, text: string) => page.getByText(text).last().click()

/** The next dispatch rejects, as if the core had refused it. */
const refuseNextDispatch = (page: Page) =>
  page.evaluate(() => {
    const { runtime } = __reflex
    const original = runtime.dispatch
    runtime.dispatch = (params: unknown) => {
      runtime.dispatch = original
      return Promise.reject(new Error(`refused: ${JSON.stringify(params)}`))
    }
  })

const ordinaryUse = async (browser: Browser) => {
  const page = await open(browser, "/")
  check({ label: "list renders from core", passed: await visible(page, "Blue T-Shirt") })
  check({ label: "derived state renders", passed: await visible(page, "5 (low)") })
  await click(page, "Blue T-Shirt")
  check({
    label: "core push moved the router",
    passed: await visible(page, "Quantity: 5"),
    detail: pathOf(page),
  })
  check({
    label: "url follows core",
    passed: pathOf(page) === "/inventory/product-123",
    detail: pathOf(page),
  })
  await click(page, "Increment")
  check({ label: "action rerenders", passed: await visible(page, "Quantity: 6") })
  await page.getByText("Save", { exact: true }).last().click()
  await coreReady(page)
  await settled(page)
  await page.goBack()
  await untilDepth(page, 1)
  check({
    label: "browser back returns to list",
    passed: pathOf(page) === "/",
    detail: pathOf(page),
  })
  check({
    label: "core popped: list reloaded the saved value",
    passed: await visible(page, "6 (low)"),
  })
  await click(page, "Grey Hoodie")
  check({
    label: "core still drivable after inbound back",
    passed: await visible(page, "Quantity: 40"),
  })
  check({
    label: "second product url",
    passed: pathOf(page) === "/inventory/product-456",
    detail: pathOf(page),
  })
  await page.goBack()
  await untilDepth(page, 1)
  await click(page, "Settings")
  check({ label: "settings opens", passed: await visible(page, "Low stock below: 10") })
  const shown = await page.evaluate(() => ({
    token: __reflex.shownToken(),
    top: __reflex.runtime.stateOf("Navigation").stack.at(-1)?.nodeId,
  }))
  check({
    label: "the router's own state names the screen on top",
    passed: shown.token !== null && shown.token === shown.top,
    detail: JSON.stringify(shown),
  })
  await click(page, "Raise threshold")
  check({ label: "settings action", passed: await visible(page, "Low stock below: 11") })
  await page.close()
}

const coldDeepLinks = async (browser: Browser) => {
  const detailPage = await open(browser, "/inventory/product-456")
  check({
    label: "cold deep link adopted by core",
    passed: await visible(detailPage, "Quantity: 40"),
  })
  check({ label: "deep link url kept", passed: pathOf(detailPage) === "/inventory/product-456" })
  await detailPage.close()

  const settingsPage = await open(browser, "/settings")
  check({
    label: "cold deep link to settings",
    passed: await visible(settingsPage, "Low stock below: 10"),
  })
  await settingsPage.close()
}

const twoPushesInOneTick = async (browser: Browser) => {
  const page = await open(browser, "/")
  await coreReady(page)
  await dispatch(page, detail("product-123"), detail("product-456"))
  await untilDepth(page, 3)
  await page.goBack()
  await untilDepth(page, 2)
  check({ label: "back shows the lower instance", passed: await visible(page, "SKU: product-123") })
  await click(page, "Increment")
  check({ label: "it acts on its own node", passed: await visible(page, "Quantity: 6") })
  await page.close()
}

const identicalUrls = async (browser: Browser) => {
  const page = await open(browser, "/")
  await coreReady(page)
  await dispatch(page, detail("product-123"))
  await untilDepth(page, 2)
  await dispatch(page, detail("product-123"))
  await untilDepth(page, 3)
  await page.goBack()
  await untilDepth(page, 2)
  check({ label: "back between identical URLs pops the core", passed: true })
  await page.close()

  const sameTick = await open(browser, "/")
  await coreReady(sameTick)
  await dispatch(sameTick, detail("product-123"), detail("product-123"))
  await untilDepth(sameTick, 3)
  await click(sameTick, "Increment")
  check({ label: "top instance changed", passed: await visible(sameTick, "Quantity: 6") })
  await sameTick.goBack()
  await untilDepth(sameTick, 2)
  check({
    label: "lower instance kept its own state",
    passed: await visible(sameTick, "Quantity: 5"),
  })
  await click(sameTick, "Increment")
  check({ label: "lower instance is live", passed: await visible(sameTick, "Quantity: 6") })
  await sameTick.close()
}

const batchedBackAfterDeepLink = async (browser: Browser) => {
  const page = await open(browser, "/inventory/product-456")
  await visible(page, "Quantity: 40")
  await coreReady(page)
  await untilDepth(page, 2)
  await dispatch(page, { action: "Navigate", input: { route: "Settings", params: {} } })
  await untilDepth(page, 3)
  await dispatch(page, { action: "GoBack" }, { action: "GoBack" })
  await untilDepth(page, 1)
  check({ label: "list is on screen", passed: await visible(page, "Blue T-Shirt") })
  check({ label: "url follows", passed: pathOf(page) === "/", detail: pathOf(page) })
  await page.close()
}

const encodedUrls = async (browser: Browser) => {
  const cases = [
    ["/inventory/100%25", "100%"],
    ["/inventory/a%2Fb", "a/b"],
    ["/inventory/a%20b", "a b"],
  ] as const
  for (const [url, id] of cases) {
    const page = await open(browser, url)
    check({ label: `encoded deep link ${url}`, passed: await visible(page, `SKU: ${id}`) })
    await coreReady(page)
    await untilDepth(page, 2)
    await page.close()
  }
  const page = await open(browser, "/")
  await coreReady(page)
  await dispatch(page, detail("a b/c%"))
  await untilDepth(page, 2)
  check({ label: "encoded core push", passed: await visible(page, "SKU: a b/c%") })
  check({ label: "one core entry", passed: (await routes(page)).length === 2 })
  await page.close()
}

const sessionReplacement = async (browser: Browser) => {
  const page = await open(browser, "/")
  await visible(page, "Blue T-Shirt")
  await coreReady(page)
  await page.evaluate(() => __reflex.setScenario("empty-inventory"))
  await page.getByText("Blue T-Shirt").waitFor({ state: "detached" })
  check({ label: "old session's data is gone", passed: true })
  await click(page, "Settings")
  check({ label: "new session answers", passed: await visible(page, "Low stock below: 10") })
  await page.close()
}

const doubleTap = async (browser: Browser) => {
  const page = await open(browser, "/")
  await visible(page, "Blue T-Shirt")
  await page
    .getByText("Blue T-Shirt")
    .last()
    .evaluate((element: HTMLElement) => {
      element.click()
      element.click()
    })
  check({ label: "double tap opens once", passed: await visible(page, "Quantity: 5") })
  await coreReady(page)
  await settled(page)
  check({ label: "double tap: one entry", passed: (await routes(page)).length === 2 })
  await page.close()
}

const warmDeepLinks = async (browser: Browser) => {
  const page = await open(browser, "/")
  await coreReady(page)
  await dispatch(page, detail("product-123"))
  await visible(page, "Quantity: 5")
  await page.evaluate(() => __reflex.router.push("/inventory/product-456"))
  check({
    label: "warm deep link shows its own product",
    passed: await visible(page, "SKU: product-456"),
  })
  await untilDepth(page, 3)
  await page.close()

  const reused = await open(browser, "/")
  await coreReady(reused)
  await dispatch(reused, detail("product-123"))
  await visible(reused, "Quantity: 5")
  await reused.evaluate(() => __reflex.router.setParams({ id: "product-456" }))
  check({ label: "reused instance rebinds", passed: await visible(reused, "Quantity: 40") })
  await reused.close()
}

const refusedNavigation = async (browser: Browser) => {
  const page = await open(browser, "/")
  await visible(page, "Blue T-Shirt")
  await coreReady(page)
  await refuseNextDispatch(page)
  await page.evaluate(() => __reflex.router.push("/settings"))
  await page.waitForURL((url) => url.pathname === "/" && url.search.includes("reflexNode"))
  check({
    label: "refused destination returns to the core's screen",
    passed: await visible(page, "Blue T-Shirt"),
  })
  check({ label: "core did not move", passed: (await routes(page)).length === 1 })
  await click(page, "Settings")
  check({ label: "next push is not swallowed", passed: await visible(page, "Low stock below: 10") })
  check({
    label: "url follows the next push",
    passed: pathOf(page) === "/settings",
    detail: pathOf(page),
  })
  await page.close()

  const back = await open(browser, "/")
  await coreReady(back)
  await dispatch(back, detail("product-123"))
  await visible(back, "Quantity: 5")
  await settled(back)
  await refuseNextDispatch(back)
  await back.goBack()
  await back.waitForURL((url) => url.pathname === "/inventory/product-123")
  check({
    label: "core kept its screen after a refused back",
    passed: (await routes(back)).length === 2,
  })
  check({ label: "router rejoined the core", passed: await visible(back, "Quantity: 5") })
  await back.close()
}

const adoptedEntryIdentity = async (browser: Browser) => {
  const page = await open(browser, "/inventory/product-123")
  await coreReady(page)
  await untilDepth(page, 2)
  await dispatch(page, detail("product-123"), detail("product-123"))
  await untilDepth(page, 4)
  await click(page, "Increment")
  await visible(page, "Quantity: 6")
  await page.goBack()
  await untilDepth(page, 3)
  await page.goBack()
  await untilDepth(page, 2)
  check({
    label: "adopted entry is back on its own node",
    passed: await visible(page, "Quantity: 5"),
  })
  await click(page, "Increment")
  check({ label: "adopted entry stays live", passed: await visible(page, "Quantity: 6") })
  await page.close()
}

const multiStepReturn = async (browser: Browser) => {
  const page = await open(browser, "/")
  await coreReady(page)
  await dispatch(page, detail("product-123"))
  await untilDepth(page, 2)
  await dispatch(page, detail("product-456"))
  await untilDepth(page, 3)
  await page.evaluate(() => history.go(-2))
  await untilDepth(page, 1)
  check({ label: "two-step back shows the root", passed: await visible(page, "Blue T-Shirt") })
  await page.close()
}

/**
 * Well inside the projection's 500 ms backstop deadline, so that only the router's
 * report of each action can pass this: no location report ever shows the push.
 */
const UNDO_REACHES_CORE_MAX_MS = 200

const pushUndoneBeforeShown = async (browser: Browser) => {
  const page = await open(browser, "/")
  await coreReady(page)
  await settled(page)
  const elapsedMs = await page.evaluate(async (limitMs) => {
    const { router, runtime } = __reflex
    const push = router.push
    let pushedAt: number | null = null
    // The user's back lands in the same turn as the projection's push.
    router.push = (href) => {
      router.push = push
      push(href)
      router.back()
      pushedAt = performance.now()
    }
    await runtime.dispatch({
      action: "Navigate",
      input: { route: "Settings", params: {} },
      await: true,
    })
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    while (runtime.stateOf("Navigation").stack.length !== 1) {
      if (pushedAt !== null && performance.now() - pushedAt > limitMs * 4) {
        return null
      }
      await frame()
    }
    return pushedAt === null ? null : performance.now() - pushedAt
  }, UNDO_REACHES_CORE_MAX_MS)
  check({
    label: "a push undone before it shows reaches the core at once",
    passed: elapsedMs !== null && elapsedMs < UNDO_REACHES_CORE_MAX_MS,
    detail: `${elapsedMs?.toFixed(1)} ms`,
  })
  check({ label: "the list is still shown", passed: await visible(page, "Blue T-Shirt") })
  await page.close()
}

const staleRootToken = async (browser: Browser) => {
  const page = await open(browser, "/?reflexNode=gone")
  await visible(page, "Blue T-Shirt")
  await coreReady(page)
  await settled(page)
  check({ label: "stale root token adds no screen", passed: (await routes(page)).length === 1 })
  await page.close()
}

const lateResultAfterReplacement = async (browser: Browser) => {
  const page = await open(browser, "/")
  await visible(page, "Blue T-Shirt")
  await coreReady(page)
  await page.evaluate(() => {
    const { runtime, router } = __reflex
    const original = runtime.dispatch
    runtime.dispatch = () => {
      runtime.dispatch = original
      return new Promise((resolve) => {
        globalThis.__finishOld = () => resolve({ status: "cancelled" })
      })
    }
    router.push("/settings")
  })
  await page.waitForFunction(() => globalThis.__finishOld !== undefined)
  await page.evaluate(() => __reflex.setScenario("empty-inventory"))
  await page.getByText("Settings").last().waitFor({ state: "visible" })
  await settled(page)
  const before = page.url()
  await page.evaluate(() => __finishOld())
  await settled(page)
  check({
    label: "late result leaves the url alone",
    passed: page.url() === before,
    detail: page.url(),
  })
  await page.close()
}

const staleStartFailure = async (browser: Browser) => {
  const page = await open(browser, "/")
  await visible(page, "Blue T-Shirt")
  await coreReady(page)
  const replace = page.evaluate(() => {
    const { setScenario } = __reflex
    setScenario("e2e-late-failure")
    return new Promise<void>((resolve) => {
      const poll = () => {
        if (globalThis.__failLateStart === undefined) {
          requestAnimationFrame(poll)
        } else {
          setScenario("empty-inventory")
          resolve()
        }
      }
      poll()
    })
  })
  await replace
  await visible(page, "Settings")
  await page.evaluate(() => __failLateStart())
  await settled(page)
  check({
    label: "a replaced start's failure leaves the new session up",
    passed: await visible(page, "Settings"),
  })
  await page.close()
}

const scenarios = [
  ordinaryUse,
  coldDeepLinks,
  twoPushesInOneTick,
  identicalUrls,
  batchedBackAfterDeepLink,
  encodedUrls,
  sessionReplacement,
  doubleTap,
  warmDeepLinks,
  refusedNavigation,
  adoptedEntryIdentity,
  multiStepReturn,
  pushUndoneBeforeShown,
  staleRootToken,
  lateResultAfterReplacement,
  staleStartFailure,
]

const runAll = async (): Promise<void> => {
  const browser = await chromium.launch({ channel: "chrome", headless: true })
  try {
    for (const scenario of scenarios) {
      await scenario(browser)
    }
  } finally {
    await browser.close()
  }
}

const deadline = setTimeout(() => {
  console.error(`Scenarios did not finish in ${SCENARIOS_TIMEOUT_MS}ms`)
  process.exit(1)
}, SCENARIOS_TIMEOUT_MS)

runAll()
  .then(() => {
    clearTimeout(deadline)
    // The refusals injected above are unexpected errors to the app, which logs them.
    const unexpected = pageErrors.filter(
      (error) => !error.includes("refused: ") && !error.includes("late failure"),
    )
    console.log("browser errors:", unexpected.length > 0 ? unexpected : "none")
    process.exit(failures.length > 0 || unexpected.length > 0 ? 1 : 0)
  })
  .catch((error: unknown) => {
    console.error(String(error).slice(0, DIAGNOSTIC_CHARACTERS_MAX))
    process.exit(1)
  })
