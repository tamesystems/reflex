import { Pressable, Text, View } from "react-native"
import { Counter } from "@reflex/example-plain"
import { useServiceStatus } from "../routes.ts"

export default function CounterView() {
  const view = useServiceStatus(Counter)
  if (view.status === "error") {
    return (
      <Text
        onPress={() => {
          void view.retry()
        }}
      >
        {view.error.message} — Retry
      </Text>
    )
  }
  if (view.status === "pending") {
    return null
  }
  return (
    <View>
      <Text>Count: {view.state.count}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void view.actions.Add.run({ by: 1 })
        }}
      >
        <Text>Add one</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={!view.actions.Reset.available}
        onPress={() => {
          void view.actions.Reset.run()
        }}
      >
        <Text>Reset</Text>
      </Pressable>
    </View>
  )
}
