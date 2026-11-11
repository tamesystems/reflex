import { Provider } from "../src/routes.ts"
import { useState, type ReactNode } from "react"
import { Text } from "react-native"
import { testHost, instrumentedApp, E2EBridge } from "./instrumentation.tsx"

export const AppProvider = ({ children }: { readonly children: ReactNode }) => {
  const [scenario, setScenario] = useState<(typeof testHost.scenarioNames)[number]>(
    __DEV__ && process.env.EXPO_PUBLIC_INVENTORY_API ? "device-services" : testHost.defaultScenario,
  )
  return (
    <Provider
      app={instrumentedApp}
      scenario={scenario}
      bridge="development"
      fallback={<Text>Starting…</Text>}
    >
      <E2EBridge setScenario={setScenario} />
      {children}
    </Provider>
  )
}
