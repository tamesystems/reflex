import { selectProvider } from "./e2e/entry.tsx"
import { Provider } from "./src/routes.ts"
import { developmentBridge } from "@reflex/expo"
import type { ReactNode } from "react"
import { Text } from "react-native"

const bridge = developmentBridge()
const ProductionProvider = ({ children }: { readonly children: ReactNode }) => (
  <Provider bridge={bridge} fallback={<Text>Starting…</Text>}>
    {children}
  </Provider>
)

export const AppProvider = selectProvider(ProductionProvider)
