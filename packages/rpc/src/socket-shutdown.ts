import { LOCAL_SHUTDOWN_RECEIPT_TIMEOUT_MS } from "@reflex/protocol"
import type { LocalCipher } from "./local-cipher.ts"

/** Windows native write completion is not delivery: wait for the shutdown reply's receipt. */
export const socketShutdown = (
  cipher: LocalCipher | undefined,
  onShutdown: (() => void) | undefined,
) => {
  let target: number | undefined
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (): void => {
    if (target === undefined || finished) {
      return
    }
    finished = true
    clearTimeout(timer)
    onShutdown?.()
  }
  return {
    request(): void {
      if (target !== undefined) {
        return
      }
      target = cipher?.sentFrames ?? 0
      if (cipher === undefined) {
        finish()
      } else {
        timer = setTimeout(finish, LOCAL_SHUTDOWN_RECEIPT_TIMEOUT_MS)
      }
    },
    received(): void {
      if (target !== undefined && cipher !== undefined && cipher.acknowledgedFrames >= target) {
        finish()
      }
    },
    closed: finish,
  }
}
