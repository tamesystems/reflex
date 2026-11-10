import { ReflexProvider } from "@reflex/react"
import { developmentBridge } from "@reflex/expo"
import { useState, type ReactNode } from "react"
import { Text } from "react-native"
import { testHost, E2EBridge } from "./instrumentation.tsx"

const bridge = developmentBridge()
export const E2EProvider = ({ children }: { readonly children: ReactNode }) => {
  const [scenario, setScenario] = useState(testHost.defaultScenario)
  return (
    <ReflexProvider
      host={testHost}
      scenario={scenario}
      bridge={bridge}
      fallback={<Text>Starting…</Text>}
    >
      <E2EBridge setScenario={setScenario} />
      {children}
    </ReflexProvider>
  )
}
