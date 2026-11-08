/**
 * An app served the way a device serves it, reached the way the CLI reaches one: the
 * real `reflex --target device serve` in a process of its own, a device in a worker that
 * dials it over a real WebSocket, and this process talking to the bridge over its socket.
 */
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type Client, createBridgeController } from "@reflex/rpc"
import type { Controller } from "@reflex/runtime"
import type { DeviceCommand, DeviceReport } from "./live-device.ts"

import { loadConfig } from "../packages/cli/src/config.ts"
import { connectToSession } from "../packages/cli/src/session.ts"

const CLI = resolve(import.meta.dirname, "../packages/cli/src/cli.ts")
const BRIDGE_READY_TIMEOUT_MS = 10_000

export interface Device {
  readonly reports: ReadonlyArray<DeviceReport>
  /** The device, told to do as an app would: stop serving, serve again, or reload. */
  readonly send: (command: DeviceCommand) => void
  readonly port: number
  readonly token: string
}

export interface BridgedOptions {
  readonly scenario?: string
  /** Dial with this token instead of the bridge's own. */
  readonly token?: string
  readonly onDevice?: (device: Device) => void
}

/** Taken by binding and releasing it. Another process could take it meanwhile; none does here. */
const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port ?? 0
  probe.stop(true)
  return port
}

const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + BRIDGE_READY_TIMEOUT_MS
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`)
    }
    await Bun.sleep(10)
  }
}

export interface ExtraDevice {
  readonly reports: ReadonlyArray<DeviceReport>
  readonly stop: () => void
}

/** Another app dialling the same bridge, as a second simulator would. */
export const openDevice = (device: Device, hostModule: string): ExtraDevice => {
  const worker = new Worker(new URL("./live-device.ts", import.meta.url))
  const reports: Array<DeviceReport> = []
  worker.onmessage = ({ data }: MessageEvent<DeviceReport>) => reports.push(data)
  const setting = `ws://127.0.0.1:${device.port}#${device.token}`
  worker.postMessage({ type: "serve", hostModule, setting } satisfies DeviceCommand)
  return { reports, stop: () => worker.terminate() }
}

export const openBridged = async (
  hostModule: string,
  options: BridgedOptions = {},
): Promise<Controller> => {
  const directory = mkdtempSync(join(tmpdir(), "reflex-bridge-"))
  const port = freePort()
  const daemon = spawn(
    process.execPath,
    [CLI, "--target", "device", "serve", "--port", String(port)],
    { env: { ...process.env, REFLEX_DIR: directory }, stdio: "ignore" },
  )
  const worker = new Worker(new URL("./live-device.ts", import.meta.url))
  const release = () => {
    worker.terminate()
    daemon.kill()
    rmSync(directory, { recursive: true, force: true })
  }
  try {
    const config = loadConfig({ ...process.env, REFLEX_DIR: directory }, "device")
    const socketPath = process.platform === "win32" ? config.authPath : config.socketPath
    await until(() => existsSync(socketPath), "the bridge's socket")
    const token = readFileSync(join(directory, "device.token"), "utf8").trim()
    let client: Client
    const deadline = Date.now() + BRIDGE_READY_TIMEOUT_MS
    for (;;) {
      try {
        client = await connectToSession(config)
        break
      } catch (error) {
        if (Date.now() >= deadline) {
          throw error
        }
        await Bun.sleep(25)
      }
    }
    const bridged = createBridgeController({
      disconnectedMessage: "The bridge went away",
      onClose: release,
    })
    bridged.attach(client)

    const reports: Array<DeviceReport> = []
    worker.onmessage = ({ data }: MessageEvent<DeviceReport>) => reports.push(data)
    const send = (command: DeviceCommand) => worker.postMessage(command)
    const dialled = options.token ?? token
    send({
      type: "serve",
      hostModule,
      setting: `ws://127.0.0.1:${port}#${dialled}`,
      ...(options.scenario === undefined ? {} : { scenario: options.scenario }),
    })
    options.onDevice?.({ reports, send, port, token })
    return bridged
  } catch (error: unknown) {
    release()
    throw error
  }
}
