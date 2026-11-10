import { ReflexProvider } from "@reflex/react"
import { developmentBridge } from "@reflex/expo/dev"
import type { ReactNode } from "react"
import { Text } from "react-native"
import app from "./src/app.ts"

const bridge = developmentBridge()
const ProductionProvider = ({ children }: { readonly children: ReactNode }) => (
  <ReflexProvider host={app} bridge={bridge} fallback={<Text>Starting…</Text>}>
    {children}
  </ReflexProvider>
)

/** Metro erases the test-only dependency edge from ordinary and production builds. */
export const AppProvider =
  process.env.EXPO_PUBLIC_REFLEX_E2E === "1"
    ? (require("./e2e/provider.tsx") as typeof import("./e2e/provider.tsx")).E2EProvider
    : ProductionProvider
