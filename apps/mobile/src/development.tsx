import type { AppHost } from "@reflex/runtime"
import type { ComponentType } from "react"

const NoTools = () => null
/** Test instrumentation has no dependency edge in a production Metro graph. */
export const developmentSession = (
  app: AppHost,
): {
  readonly host: AppHost
  readonly Tools: ComponentType<{ readonly setScenario: (scenario: string) => void }>
} => {
  if (process.env.EXPO_PUBLIC_REFLEX_E2E === "1") {
    const tools = require("./e2e.tsx") as typeof import("./e2e.tsx")
    return { host: tools.testHost, Tools: tools.E2EBridge }
  }
  return { host: app, Tools: NoTools }
}
