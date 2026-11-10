import type { Bridge } from "./bridge.ts"
declare global {
  interface ImportMetaEnv {
    DEV: boolean
    readonly VITE_REFLEX_BRIDGE?: string
  }
}

/** Vite erases the complete development branch from production JavaScript. */
export const developmentBridge = async (): Promise<Bridge | undefined> => {
  if (import.meta.env.DEV) {
    const setting = import.meta.env.VITE_REFLEX_BRIDGE
    if (setting) {
      const { connectBridge } = await import("./bridge.ts")
      return connectBridge(setting)
    }
  }
  return undefined
}
