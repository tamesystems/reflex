import type { ReactNode } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"

export const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: "600" },
  row: { padding: 12, flexDirection: "row", justifyContent: "space-between" },
  error: { color: "#a00" },
})
export function Screen({ children }: { children: ReactNode }) {
  return <View style={{ padding: 20, gap: 12 }}>{children}</View>
}
export function Action({
  title,
  available,
  pending,
  reason,
  run,
}: {
  title: string
  available: boolean
  pending: boolean
  reason: string | null
  run: () => Promise<unknown>
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={reason ?? undefined}
      disabled={!available || pending}
      onPress={() => {
        void run()
      }}
    >
      <Text>{title}</Text>
    </Pressable>
  )
}
