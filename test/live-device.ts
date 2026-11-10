/**
 * A device, as far as the bridge can tell: an app's live sessions behind `@reflex/live`'s
 * controller, dialling out over a WebSocket. It runs in a worker, with an event loop of
 * its own, as an app on a phone has. Only React and the screen are missing.
 */
import type { AppHost, Controller } from "@reflex/runtime/internal"
import { systemTimers } from "@reflex/runtime/internal"
import { type Bridge, type BridgeStatus, connectBridge } from "../packages/live/src/bridge.ts"
import { createLiveController } from "../packages/live/src/live-controller.ts"
import { LiveSessions } from "../packages/live/src/live-sessions.ts"

declare const self: Worker

export type DeviceCommand =
  | {
      readonly type: "serve"
      readonly hostModule: string
      readonly setting: string
      readonly scenario?: string
    }
  | { readonly type: "stop-serving" }
  | { readonly type: "serve-again" }
  | { readonly type: "reload" }

export type DeviceReport =
  | { readonly type: "status"; readonly status: BridgeStatus }
  | { readonly type: "reported"; readonly message: string }

const post = (report: DeviceReport) => self.postMessage(report)
const report = (error: unknown) =>
  post({ type: "reported", message: error instanceof Error ? error.message : String(error) })

let bridge: Bridge | null = null
let host: AppHost | null = null
let scenario: string | undefined
/** The running app: its sessions and the controller over them. */
let app: { readonly live: Controller; readonly close: () => void } | null = null
let stopServing: (() => void) | null = null

const serve = () => {
  if (bridge !== null && app !== null && stopServing === null) {
    stopServing = bridge(app.live)
  }
}

const unserve = () => {
  stopServing?.()
  stopServing = null
}

/** A fresh app, as after a reload: new sessions, so new session ids, and a new controller. */
const launch = () => {
  if (host === null) {
    return
  }
  const sessions = new LiveSessions({ timers: systemTimers, onBackgroundError: report })
  const close = sessions.open(host, scenario)
  const live = createLiveController(sessions, report)
  app = {
    live,
    close: () => {
      live.close().catch(report)
      close()
    },
  }
}

self.onmessage = async ({ data }: MessageEvent<DeviceCommand>) => {
  switch (data.type) {
    case "serve": {
      const loaded: { default: AppHost } = await import(data.hostModule)
      host = loaded.default
      scenario = data.scenario
      bridge = connectBridge(data.setting, {
        onBackgroundError: report,
        onStatus: (status) => post({ type: "status", status }),
      })
      launch()
      serve()
      return
    }
    // The same app, losing its connection and finding it again.
    case "stop-serving":
      unserve()
      return
    case "serve-again":
      serve()
      return
    case "reload":
      unserve()
      app?.close()
      launch()
      serve()
      return
  }
}
