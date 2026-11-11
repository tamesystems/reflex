import { useRuntime } from "@reflex/react/internal"
import { useCoreStack, useShownToken } from "./react.tsx"

/** Development instrumentation can observe the active session and router projection. */
export const useTesting = () => ({
  runtime: useRuntime(),
  stack: useCoreStack(),
  shownToken: useShownToken(),
})
