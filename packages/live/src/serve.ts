import {
  type AppHost,
  createController,
  reportToConsole,
  type BackgroundReporter,
} from "@reflex/runtime/internal"
import { connectBridge } from "./bridge.ts"

/** Serve a plain process; close waits for its owned session's disposal. */
export const serveLive = async (
  app: AppHost,
  options: {
    readonly setting: string
    readonly scenario?: string
    readonly onBackgroundError?: BackgroundReporter
  },
): Promise<{ close(): Promise<void> }> => {
  const report = options.onBackgroundError ?? reportToConsole
  const bridge = connectBridge(options.setting, { onBackgroundError: report })
  const controller = await createController(app, {
    ...(options.scenario === undefined ? {} : { scenario: options.scenario }),
    onBackgroundError: report,
  })
  try {
    const stop = bridge(controller)
    let closing: Promise<void> | undefined
    return {
      close: () => {
        if (closing === undefined) {
          stop()
          closing = controller.close()
        }
        return closing
      },
    }
  } catch (error) {
    await controller.close()
    throw error
  }
}
