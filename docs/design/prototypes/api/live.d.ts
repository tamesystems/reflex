import type * as M from "./model"
export type { JourneyClient } from "./model"
export type BackgroundReporter = (error: {
  message: string
  node?: string
  action?: string
}) => void
export interface Bridge {
  close(): Promise<void>
}
export declare function connectBridge(setting: string): Bridge
export declare function serveLive<A extends M.AnyApp>(
  app: A,
  options: { setting: string; onBackgroundError?: BackgroundReporter },
): Promise<{ client: M.JourneyClient<A>; close(): Promise<void> }>
