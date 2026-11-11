import type { Bridge } from "./bridge.ts"
/** Host-neutral no-op; host dev entries read their own development settings. */
export const developmentBridge: Bridge = () => () => undefined
