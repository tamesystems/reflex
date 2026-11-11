import type { ReactNode } from "react"
import { developmentBridge } from "@reflex/expo/dev"
import { reflex } from "./src/routes.ts"

const bridge = developmentBridge()
export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <reflex.Provider fallback={null} bridge={bridge}>
      {children}
    </reflex.Provider>
  )
}
