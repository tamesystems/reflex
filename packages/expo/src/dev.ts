import type { Bridge } from "@reflex/live/session"
declare const __DEV__: boolean

/** Metro removes this branch, including the token read and dialler, in production. */
export const developmentBridge: Bridge = (controller) =>
  __DEV__ && process.env.EXPO_PUBLIC_REFLEX_BRIDGE
    ? (require("@reflex/live") as typeof import("@reflex/live")).connectBridge(
        process.env.EXPO_PUBLIC_REFLEX_BRIDGE,
      )(controller)
    : () => undefined
