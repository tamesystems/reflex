import type { ComponentType, ReactNode } from "react"
export const selectProvider = (production: ComponentType<{ readonly children: ReactNode }>) =>
  process.env.EXPO_PUBLIC_REFLEX_E2E === "1"
    ? (require("./provider.tsx") as typeof import("./provider.tsx")).E2EProvider
    : production
