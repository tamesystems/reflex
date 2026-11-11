import { useMemo } from "react"
import { useRuntime } from "@reflex/react/internal"
import type { DispatchParams, OperationInfo, WaitParams, WaitResult, Json } from "@reflex/protocol"
import { useCoreStack, useShownToken } from "./react.tsx"

/** The small observation/interception surface used by browser journeys. */
interface TestingRuntime {
  stateOf(name: string): Json | undefined
  dispatch(params: DispatchParams): Promise<OperationInfo>
  wait(params: WaitParams): Promise<WaitResult>
}

/** Development instrumentation observes the session without exposing its registry. */
export const useTesting = () => {
  const runtime = useRuntime()
  const handle = useMemo(
    (): TestingRuntime => ({
      stateOf: (name) => runtime.stateOf(name),
      get dispatch() {
        return runtime.dispatch.bind(runtime)
      },
      set dispatch(dispatch) {
        runtime.dispatch = dispatch
      },
      wait: (params) => runtime.wait(params),
    }),
    [runtime],
  )
  return { runtime: handle, stack: useCoreStack(), shownToken: useShownToken() }
}
