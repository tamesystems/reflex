import { boundedText } from "@reflex/protocol"

/** For failures with nobody left to tell. */
export type BackgroundReporter = (error: unknown) => void

/** One structured line with chosen fields, never the failure object itself. */
export const reportToConsole: BackgroundReporter = (error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({ event: "background_failure", message: boundedText(message) }))
}
