import type { ReactNode } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"

export const Screen = ({ children }: { readonly children: ReactNode }) => (
  <View style={styles.screen}>{children}</View>
)

export const Action = ({
  title,
  onPress,
  run,
  available = true,
  pending = false,
  disabled = false,
}: {
  readonly title: string
  readonly onPress?: () => void
  readonly run?: () => unknown
  readonly available?: boolean
  readonly pending?: boolean
  readonly disabled?: boolean
}) => (
  <Pressable
    accessibilityRole="button"
    disabled={disabled || !available || pending}
    onPress={() => (run ?? onPress)?.()}
    style={[styles.action, disabled && styles.disabled]}
  >
    <Text style={styles.actionText}>{title}</Text>
  </Pressable>
)

export const styles = StyleSheet.create({
  screen: { flex: 1, gap: 12, padding: 16 },
  title: { fontSize: 22, fontWeight: "600" },
  action: { alignItems: "center", backgroundColor: "#1f6feb", borderRadius: 8, padding: 12 },
  actionText: { color: "white", fontWeight: "600" },
  disabled: { opacity: 0.4 },
  error: { color: "#b42318" },
  row: { flexDirection: "row", gap: 8, justifyContent: "space-between", padding: 8 },
})
