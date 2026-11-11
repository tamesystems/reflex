import { developmentBridge } from "@reflex/expo/dev"
import type { ReactNode } from "react"
import { Provider } from "./src/routes.ts"

export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <Provider fallback={null} bridge={developmentBridge}>
      {children}
    </Provider>
  )
}
