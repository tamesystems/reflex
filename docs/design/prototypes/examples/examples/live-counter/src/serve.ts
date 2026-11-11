import { serveLive } from "@reflex/live"
import app from "./app.ts"

const setting = process.env.REFLEX_BRIDGE
if (!setting) {
  throw new Error("Set REFLEX_BRIDGE to the appSetting printed by reflex --target device start")
}
const server = await serveLive(app, { setting })
const shutdown = () => {
  void server.close().catch(console.error)
}
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
