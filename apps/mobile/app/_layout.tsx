import { RouterProjection } from "@reflex/expo"
import { Stack } from "expo-router"
import { AppProvider } from "../provider.tsx"
import { routes } from "../src/routes.ts"

export default function Layout() {
  return (
    <AppProvider>
      <RouterProjection routes={routes} />
      <Stack />
    </AppProvider>
  )
}
