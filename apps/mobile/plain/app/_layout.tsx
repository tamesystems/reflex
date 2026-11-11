import { developmentBridge } from "@reflex/expo/dev"
import { Stack } from "expo-router"
import { Provider } from "../routes.ts"

export default function Layout() {
  return (
    <Provider fallback={null} bridge={developmentBridge}>
      <Stack />
    </Provider>
  )
}
