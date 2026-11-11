import type { NodeView, ReadyNodeView, ActionView } from "@reflex/react"
import type { ActionOutcome } from "@reflex/runtime"
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
} & ActionView<() => Promise<ActionOutcome<unknown>>>) {
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

/** Share the opt-in status rendering across screens; domain loading stays in each view. */
export function ScreenStatus<D>({
  view,
  children,
}: {
  view: NodeView<D>
  children: (view: ReadyNodeView<D>) => ReactNode
}) {
  if (view.status === "pending") {
    return null
  }
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
  return children(view)
}
