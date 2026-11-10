import { plainBackend } from "../../../examples/plain/src/app.ts"
import {
  type BridgeConnector,
  ReflexProvider,
  send,
  useNode,
  useNodeFocus,
  useNodeState,
  useSession,
} from "@reflex/react"
import { isRecord } from "@reflex/protocol"
import { registerRootComponent } from "expo"
import { useState } from "react"
import { Button, Text, View } from "react-native"

// The existing app owns this small navigation state, without RouterProjection.
const CounterScreen = ({ leave }: { readonly leave: () => void }) => {
  const { runtime } = useSession()
  const { node } = runtime.inspect({ name: "Counter" })
  const live = useNode(node?.id ?? null)
  const state = useNodeState(live)
  useNodeFocus(live?.id ?? null, true)
  return (
    <View>
      <Text>Plain Zustand counter</Text>
      <Text testID="count">Count: {isRecord(state) ? String(state.count) : "loading"}</Text>
      <Button title="Leave counter" onPress={leave} />
      <Button
        title="Add one"
        onPress={() => {
          if (live) {
            send(live, "Add", { by: 1 })
          }
        }}
      />
    </View>
  )
}
const bridge: BridgeConnector | undefined =
  __DEV__ && process.env.EXPO_PUBLIC_REFLEX_BRIDGE
    ? (require("@reflex/live") as typeof import("@reflex/live")).connectBridge(
        process.env.EXPO_PUBLIC_REFLEX_BRIDGE,
      )
    : undefined
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
