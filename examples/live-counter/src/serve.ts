import { connectBridge, createLiveController, LiveSessions } from "@reflex/live"
import { systemTimers } from "@reflex/runtime"
import app from "./app.ts"

const setting = process.env.REFLEX_BRIDGE
if (!setting) {
  throw new Error("Set REFLEX_BRIDGE to the appSetting printed by reflex --target device start")
}
const report = (error: unknown) => console.error(error)
const sessions = new LiveSessions({ timers: systemTimers, onBackgroundError: report })
const close = sessions.open(app, undefined)
const controller = createLiveController(sessions, report)
const stopBridge = connectBridge(setting, { onBackgroundError: report })(controller)
const shutdown = () => {
  stopBridge()
  close()
  controller.close().catch(report)
}
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
