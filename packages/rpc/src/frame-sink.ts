import { write as writeToFile } from "node:fs"
import { WRITE_QUEUE_BYTES_MAX } from "@reflex/protocol"
import { systemTimers, type Timers } from "@reflex/runtime"

/** How soon to try a full pipe again, when it is one that says so rather than blocks. */
const PIPE_FULL_RETRY_MS = 1

export interface FrameSinkOptions {
  readonly fd: number
  readonly onBroken: () => void
  readonly timers?: Timers
  readonly write?: typeof writeToFile
}

/**
 * Frames on their way to a file descriptor. Not `process.stdout`, which under Bun takes
 * everything at once and reports nothing: a caller could neither limit what was queued
 * nor know when it had gone, and exiting drops whatever had not.
 */
export class FrameSink {
  private queue: Array<Buffer> = []
  private queuedByteCount = 0
  private writing = false
  private broken = false
  private readonly flushWaiters: Array<() => void> = []

  private readonly fd: number
  private readonly onBroken: () => void
  private readonly timers: Timers
  private readonly write: typeof writeToFile

  constructor(options: FrameSinkOptions) {
    this.fd = options.fd
    this.onBroken = options.onBroken
    this.timers = options.timers ?? systemTimers
    this.write = options.write ?? writeToFile
  }

  /** Returns false, having queued nothing, if this frame would go over the limit. */
  offer(frame: Buffer): boolean {
    if (this.queuedByteCount + frame.length > WRITE_QUEUE_BYTES_MAX) {
      return false
    }
    if (!this.broken) {
      this.queue.push(frame)
      this.queuedByteCount += frame.length
      this.writeNext()
    }
    return true
  }

  /** Settles once everything offered has been written, or never can be. */
  flushed(): Promise<void> {
    if (this.broken || this.queuedByteCount === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.flushWaiters.push(resolve)
    })
  }

  private writeNext(): void {
    if (this.writing || this.broken) {
      return
    }
    if (this.queue.length === 0) {
      this.resolveFlushWaiters()
      return
    }
    this.writing = true
    const frames = Buffer.concat(this.queue)
    this.queue = []
    this.writeFrom(frames, 0)
  }

  private writeFrom(frames: Buffer, offset: number): void {
    this.write(this.fd, frames, offset, frames.length - offset, null, (error, writtenByteCount) => {
      if (error?.code === "EAGAIN") {
        this.timers.setTimeout(() => this.writeFrom(frames, offset), PIPE_FULL_RETRY_MS)
      } else if (error) {
        this.break()
      } else {
        this.queuedByteCount -= writtenByteCount
        if (offset + writtenByteCount < frames.length) {
          this.writeFrom(frames, offset + writtenByteCount)
        } else {
          this.writing = false
          this.writeNext()
        }
      }
    })
  }

  private break(): void {
    this.broken = true
    this.queue = []
    this.queuedByteCount = 0
    this.resolveFlushWaiters()
    this.onBroken()
  }

  private resolveFlushWaiters(): void {
    for (const resolve of this.flushWaiters.splice(0)) {
      resolve()
    }
  }
}
