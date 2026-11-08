import { useCoreStack, useSession, useShownToken } from "@reflex/expo"
import type { AppHost } from "@reflex/runtime"
import { router } from "expo-router"
import { useEffect } from "react"

/**
 * A host whose start for `LATE_FAILURE_SCENARIO` fails only when told to, so that
 * the journey can replace a start while it is pending.
 */
export const LATE_FAILURE_SCENARIO = "e2e-late-failure"

export const withLateFailure = (host: AppHost): AppHost => ({
  ...host,
  scenarios: [...host.scenarios, { name: LATE_FAILURE_SCENARIO, virtualTime: false }],
  start: (name, options) => {
    if (name !== LATE_FAILURE_SCENARIO) {
      return host.start(name, options)
    }
    return new Promise((_, reject) => {
      globals.__failLateStart = () => reject(new Error("late failure"))
    })
  },
})

/** Lets the browser journey read and steer the core. Absent from other builds. */
const globals = globalThis as Record<string, unknown>

export const E2EBridge = ({
  setScenario,
}: {
  readonly setScenario: (scenario: string) => void
}) => {
  const { runtime } = useSession()
  const stack = useCoreStack()
  const shownToken = useShownToken()
  useEffect(() => {
    globals.__reflex = { router, runtime, stack, setScenario, shownToken }
  }, [runtime, stack, setScenario, shownToken])
  return null
}
