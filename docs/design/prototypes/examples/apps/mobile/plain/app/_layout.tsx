import { Stack } from "expo-router"
import { developmentBridge } from "@reflex/expo/dev"
import { reflex } from "../routes.ts"

const bridge = developmentBridge()
export default function Layout() {
  return (
    <reflex.Provider fallback={null} bridge={bridge}>
      <Stack />
    </reflex.Provider>
  )
}
