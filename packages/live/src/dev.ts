import type { Bridge } from "./bridge.ts"
/** Hosts replace this entry with their development-only bridge implementation. */
export const developmentBridge = (): Bridge | undefined => undefined
