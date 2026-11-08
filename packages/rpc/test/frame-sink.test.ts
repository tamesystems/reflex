import { expect, test } from "bun:test"
import type { write as writeToFile } from "node:fs"
import { WRITE_QUEUE_BYTES_MAX } from "@reflex/protocol"
import { FrameSink } from "../src/frame-sink.ts"

type WriteDone = (error: NodeJS.ErrnoException | null, writtenByteCount: number) => void

/** A file descriptor that answers each write as the test says. */
const scriptedFd = (answers: ReadonlyArray<{ code?: string; byteCount?: number }>) => {
  const written: Array<Buffer> = []
  const remaining = [...answers]
  const write = (
    _fd: number,
    data: Buffer,
    offset: number,
    length: number,
    _position: null,
    done: WriteDone,
  ) => {
    const answer = remaining.shift() ?? {}
    if (answer.code !== undefined) {
      done(Object.assign(new Error(answer.code), { code: answer.code }), 0)
      return
    }
    const byteCount = answer.byteCount ?? length
    written.push(data.subarray(offset, offset + byteCount))
    done(null, byteCount)
  }
  const pending: Array<() => void> = []
  const timers = {
    setTimeout: (callback: () => void) => {
      pending.push(callback)
      return callback
    },
    clearTimeout: () => undefined,
  }
  const text = () => Buffer.concat(written).toString()
  // Only what the sink needs of `fs.write`, whose full overloads a fake cannot have.
  return { write: write as unknown as typeof writeToFile, timers, pending, text }
}

test("a partial write continues from where it stopped", async () => {
  const fd = scriptedFd([{ byteCount: 2 }, { byteCount: 1 }])
  const sink = new FrameSink({ fd: 1, onBroken: () => undefined, ...fd })
  sink.offer(Buffer.from("hello"))
  await sink.flushed()
  expect(fd.text()).toBe("hello")
})

test("a full pipe is tried again, and nothing is lost or flushed early", async () => {
  const fd = scriptedFd([{ code: "EAGAIN" }])
  const sink = new FrameSink({ fd: 1, onBroken: () => undefined, ...fd })
  sink.offer(Buffer.from("hello"))
  let flushed = false
  const flushing = sink.flushed().then(() => {
    flushed = true
  })
  await Promise.resolve()
  expect(flushed).toBe(false)
  expect(fd.pending).toHaveLength(1)
  fd.pending[0]?.()
  await flushing
  expect(fd.text()).toBe("hello")
})

test("frames offered while one is being written follow it, in order", async () => {
  const fd = scriptedFd([{ code: "EAGAIN" }])
  const sink = new FrameSink({ fd: 1, onBroken: () => undefined, ...fd })
  sink.offer(Buffer.from("one "))
  sink.offer(Buffer.from("two"))
  fd.pending[0]?.()
  await sink.flushed()
  expect(fd.text()).toBe("one two")
})

test("a broken descriptor says so once, and settles whoever is waiting", async () => {
  const fd = scriptedFd([{ code: "EPIPE" }])
  let brokenCount = 0
  const sink = new FrameSink({
    fd: 1,
    onBroken: () => {
      brokenCount++
    },
    ...fd,
  })
  sink.offer(Buffer.from("hello"))
  await sink.flushed()
  sink.offer(Buffer.from("more"))
  await sink.flushed()
  expect(brokenCount).toBe(1)
  expect(fd.text()).toBe("")
})

test("a frame that would pass the limit is refused, and one at it is not", () => {
  const fd = scriptedFd(Array.from({ length: 3 }, () => ({ code: "EAGAIN" })))
  const sink = new FrameSink({ fd: 1, onBroken: () => undefined, ...fd })
  expect(sink.offer(Buffer.alloc(WRITE_QUEUE_BYTES_MAX))).toBe(true)
  expect(sink.offer(Buffer.alloc(1))).toBe(false)
})
