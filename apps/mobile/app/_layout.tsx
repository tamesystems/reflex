import { Suspense } from "react"
import { Stack } from "expo-router"
import { AppProvider } from "../provider.tsx"
import { RouterProjection } from "../src/routes.ts"

export default function Layout() {
  return (
    <AppProvider>
      <RouterProjection />
      <Suspense fallback={null}>
        <Stack />
      </Suspense>
    </AppProvider>
  )
}
