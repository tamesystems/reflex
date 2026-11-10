import { developmentBridge } from "@reflex/expo/dev"
import app from "../src/app.ts"
import { ReflexProvider } from "@reflex/react"
import { RouterProjection } from "@reflex/expo"
import { Stack } from "expo-router"
import { useState } from "react"
import { Text } from "react-native"
import { developmentSession } from "../src/development.tsx"
import { routes } from "../src/routes.ts"

const { host, Tools } = developmentSession(app)
const bridge = developmentBridge()

export default function Layout() {
  const [scenario, setScenario] = useState(app.defaultScenario)
  return (
    <ReflexProvider
      bridge={bridge}
      fallback={<Text>Starting…</Text>}
      host={host}
      scenario={scenario}
    >
      <RouterProjection routes={routes} />
      <Tools setScenario={setScenario} />
      <Stack />
    </ReflexProvider>
  )
}
