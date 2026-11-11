import { Stack } from "expo-router"
import { AppProvider } from "@inventory-provider"

export default function Layout() {
  return (
    <AppProvider>
      <Stack />
    </AppProvider>
  )
}
