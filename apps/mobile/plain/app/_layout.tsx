import { Stack } from "expo-router"
import { Provider } from "../routes.ts"

export default function Layout() {
  return (
    <Provider fallback={null} bridge="development">
      <Stack />
    </Provider>
  )
}
