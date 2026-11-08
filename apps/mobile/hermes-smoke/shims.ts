/**
 * Globals a device gets from React Native and Hermes's own extensions, absent
 * from this older bare VM. Effect constructs these at module load, but this
 * journey never encodes or decodes bytes, so calling one is a test failure.
 */
const globals = globalThis as Record<string, unknown>

class ByteCodecStub {
  encode(): never {
    throw new Error("TextEncoder is a smoke-test stub")
  }
  decode(): never {
    throw new Error("TextDecoder is a smoke-test stub")
  }
}

globals.TextEncoder ??= ByteCodecStub
globals.TextDecoder ??= ByteCodecStub
globals.queueMicrotask ??= (callback: () => void) => {
  Promise.resolve()
    .then(callback)
    .catch((error: unknown) => print(`microtask failed: ${String(error)}`))
}

declare const print: (message: string) => void

export {}
