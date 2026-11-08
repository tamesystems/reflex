import type { Socket } from "node:net"

/** Count writes until their completion callbacks; writableLength differs across runtimes. */
export const socketWriter = (socket: Socket, maximumBytes: number) => {
  let pendingBytes = 0
  return (frame: Buffer): boolean => {
    if (pendingBytes + frame.length > maximumBytes) {
      return false
    }
    pendingBytes += frame.length
    try {
      socket.write(frame, () => {
        pendingBytes -= frame.length
      })
      return true
    } catch {
      pendingBytes -= frame.length
      return false
    }
  }
}
