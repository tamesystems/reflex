import { developmentBridge } from "@reflex/expo/dev"
import { Counter, plainBackend } from "../../../examples/plain/src/app.ts"
import { ReflexProvider, useNode, useNodeFocus, useNodeState } from "@reflex/react"
import { registerRootComponent } from "expo"
import { useState } from "react"
import { Button, Text, View } from "react-native"

// The existing app owns this small navigation state, without RouterProjection.
const CounterScreen = ({ leave }: { readonly leave: () => void }) => {
  const live = useNode(Counter)
  const state = useNodeState(live)
  useNodeFocus(live, true)
  return (
    <View>
      <Text>Plain Zustand counter</Text>
      <Text testID="count">Count: {state?.count ?? "loading"}</Text>
      <Button title="Leave counter" onPress={leave} />
      <Button
        title="Add one"
        onPress={() => {
          if (live) {
            void live.actions.Add({ by: 1 })
          }
        }}
      />
    </View>
  )
}
const bridge = developmentBridge()
const ExistingScreens = () => {
  const [counterVisible, setCounterVisible] = useState(true)
  return counterVisible ? (
    <CounterScreen leave={() => setCounterVisible(false)} />
  ) : (
    <View>
      <Text>Unexposed screen</Text>
      <Button title="Return to counter" onPress={() => setCounterVisible(true)} />
    </View>
  )
}
const App = () => (
  <ReflexProvider host={plainBackend} bridge={bridge}>
    <ExistingScreens />
  </ReflexProvider>
)
registerRootComponent(App)
