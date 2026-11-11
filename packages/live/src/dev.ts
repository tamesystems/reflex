import type { Bridge } from "./bridge.ts"
/** Explicitly pass the host's developmentBridge factory to Provider.bridge. */
export const developmentBridge = (): Bridge | undefined => {
  console.warn(
    "Reflex development bridge is unavailable. Pass developmentBridge from @reflex/expo/dev (Expo) or @reflex/live/vite (Vite) to Provider.bridge.",
  )
  return undefined
}
