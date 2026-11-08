import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import {
  LOCAL_AUTH_FRAMES_MAX,
  LOCAL_ENCRYPTED_FRAME_CHARACTERS_MAX,
  LOCAL_UNACKNOWLEDGED_FRAMES_MAX,
  LOCAL_RECEIPT_BYTES,
  WRITE_QUEUE_BYTES_MAX,
} from "@reflex/protocol"

const iv = (sequence: number): Buffer => {
  if (sequence >= LOCAL_AUTH_FRAMES_MAX) {
    throw new Error("Local session frame budget exhausted")
  }
  const value = Buffer.alloc(12)
  value.writeUInt32BE(sequence, 8)
  return value
}

/** Encryption plus unpredictable proof-of-read credits: even native queues remain bounded. */
export class LocalCipher {
  private sent = 0
  private received = 0
  private receivedToken = ""
  private acknowledged = 0
  private acknowledgedToken = ""
  private pendingBytes = 0
  private readonly pending = new Map<number, { readonly bytes: number; readonly token: string }>()

  constructor(
    private readonly outgoing: Buffer,
    private readonly incoming: Buffer,
  ) {}

  get sentFrames(): number {
    return this.sent
  }
  get acknowledgedFrames(): number {
    return this.acknowledged
  }

  encode(line: string | null, maximumBytes = WRITE_QUEUE_BYTES_MAX): string {
    const token = randomBytes(LOCAL_RECEIPT_BYTES).toString("hex")
    const header = `${this.received}:${this.receivedToken}:${line === null ? "a" : "d"}\n`
    const cipher = createCipheriv("aes-256-gcm", this.outgoing, iv(this.sent))
    const frame = Buffer.concat([
      cipher.update(header + (line ?? "") + token, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64")
    if (
      this.pending.size >= LOCAL_UNACKNOWLEDGED_FRAMES_MAX ||
      this.pendingBytes + frame.length + 1 > maximumBytes
    ) {
      throw new Error("Local peer is not reading")
    }
    this.sent++
    this.pending.set(this.sent, { bytes: frame.length + 1, token })
    this.pendingBytes += frame.length + 1
    return frame
  }

  decode(line: string): string | null {
    line = line.replace(/\r$/, "")
    if (
      line.length > LOCAL_ENCRYPTED_FRAME_CHARACTERS_MAX ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(line)
    ) {
      throw new Error("Invalid encrypted frame")
    }
    const bytes = Buffer.from(line, "base64")
    if (bytes.length < 16) {
      throw new Error("Invalid encrypted frame")
    }
    const cipher = createDecipheriv("aes-256-gcm", this.incoming, iv(this.received++))
    cipher.setAuthTag(bytes.subarray(-16))
    const plain = Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]).toString(
      "utf8",
    )
    const newline = plain.indexOf("\n")
    const [count = "", receipt = "", kind = ""] = plain.slice(0, newline).split(":")
    const token = plain.slice(-LOCAL_RECEIPT_BYTES * 2)
    if (
      newline < 0 ||
      !/^\d{1,10}$/.test(count) ||
      !/^[a-f0-9]{32}$/.test(token) ||
      (kind !== "a" && kind !== "d")
    ) {
      throw new Error("Invalid local receipt")
    }
    this.acceptReceipt(Number(count), receipt)
    this.receivedToken = token
    const payload = plain.slice(newline + 1, -LOCAL_RECEIPT_BYTES * 2)
    if (kind === "a" && payload !== "") {
      throw new Error("Invalid local acknowledgement")
    }
    return kind === "a" ? null : payload
  }

  private acceptReceipt(credit: number, receipt: string): void {
    if (credit < this.acknowledged || credit > this.sent) {
      throw new Error("Invalid local receipt")
    }
    const expected =
      credit === this.acknowledged ? this.acknowledgedToken : this.pending.get(credit)?.token
    if (expected === undefined || receipt !== expected) {
      throw new Error("Invalid local receipt proof")
    }
    if (credit === this.acknowledged) {
      return
    }
    for (const [sequence, frame] of this.pending) {
      if (sequence > credit) {
        break
      }
      this.pendingBytes -= frame.bytes
      this.pending.delete(sequence)
    }
    this.acknowledged = credit
    this.acknowledgedToken = receipt
  }
}
