import { mountEffect } from "@reflex/effect/advanced"
import { CounterLive } from "./selected.ts"
// Advanced mounting remains scoped: this Effect requires Scope and cannot run unscoped.
export const owned = mountEffect(CounterLive)
