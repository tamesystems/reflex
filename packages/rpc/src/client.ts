import {
  assertNever,
  boundedText,
  CANCEL_NOTIFICATION,
  CLIENT_LISTENERS_MAX,
  CLIENT_PENDING_REQUESTS_MAX,
  CLIENT_REQUEST_TIMEOUT_MS_DEFAULT,
  ErrorCode,
  isRecord,
  type Json,
  type Method,
  type Methods,
  parseServerMessage,
  ProtocolError,
  resultParsers,
  type RuntimeEvent,
  type ServerMessage,
  SESSION_DISPOSE_TIMEOUT_MS_DEFAULT,
  SESSION_START_TIMEOUT_MS_MAX,
  WAIT_TIMEOUT_MS_MAX,
} from "@reflex/protocol"
import {
  type BackgroundReporter,
  type Controller,
  reportToConsole,
  systemTimers,
  type Timers,
} from "@reflex/runtime/internal"
import { createConnection } from "./server.ts"

export interface RequestOptions {
  /** How long to wait for the reply. Never forever: a server can hang. */
  readonly timeoutMs?: number
  /** Stops waiting, and asks the server to stop waiting too. */
  readonly signal?: AbortSignal
}

export interface Client {
  request<M extends Method>(
    method: M,
    params: Methods[M]["params"],
    options?: RequestOptions,
  ): Promise<Methods[M]["result"]>
  /** Each subscription delivers separately, identified by the second argument. */
  onEvent(listener: EventListener): () => void
  /** Settles when the client ends, with why, or null if it was closed on purpose. */
  readonly ended: Promise<Error | null>
  /** True from the moment it ends, before `ended` settles. */
  readonly isEnded: boolean
  close(): void
}

export type EventListener = (event: RuntimeEvent, subscriptionId: string) => void

export interface ClientTransport {
  send(line: string): void
  /** Release the transport. Called once, when the client ends for any reason. */
  close?(): void
  readonly timers?: Timers
  readonly onBackgroundError?: BackgroundReporter
}

interface Pending {
  readonly method: Method
  readonly timer: unknown
  resolve(result: unknown): void
  reject(error: Error): void
}

/** Time for a reply to cross the wire, on top of what the server itself waits. */
const REPLY_MARGIN_MS = 1_000

/** The server owns these deadlines, so a client must not give up before it answers. */
const replyTimeoutMs = (method: Method, params: unknown): number => {
  if (method === "app.reset") {
    // Start budgets can be configured on the server; resets must cover that maximum.
    const budgetMs = SESSION_DISPOSE_TIMEOUT_MS_DEFAULT + SESSION_START_TIMEOUT_MS_MAX
    return budgetMs + REPLY_MARGIN_MS
  }
  if (!isRecord(params)) {
    return CLIENT_REQUEST_TIMEOUT_MS_DEFAULT
  }
  if (params.await === true) {
    return WAIT_TIMEOUT_MS_MAX + REPLY_MARGIN_MS
  }
  if (typeof params.timeoutMs === "number") {
    return params.timeoutMs + REPLY_MARGIN_MS
  }
  return CLIENT_REQUEST_TIMEOUT_MS_DEFAULT
}

const cancelled = (): ProtocolError =>
  new ProtocolError(ErrorCode.SessionClosed, "The caller no longer wants the answer")

const KNOWN_ERROR_CODES: ReadonlySet<number> = new Set(Object.values(ErrorCode))

const isErrorCode = (code: number): code is ErrorCode => KNOWN_ERROR_CODES.has(code)

/** A code from a newer server is reported as what it is, an error not understood here. */
const protocolErrorFrom = (code: number, message: string, data: Json | undefined): ProtocolError =>
  isErrorCode(code)
    ? new ProtocolError(code, message, data)
    : new ProtocolError(ErrorCode.InternalError, `Server error ${code}: ${message}`, data)

/** Build a client over anything that moves newline-delimited messages. */
export const createClient = (transport: ClientTransport): TransportClient =>
  new TransportClient(transport)

export class TransportClient implements Client {
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<EventListener>()
  private readonly timers: Timers
  private lastRequestId = 0
  /** Set once the client has ended; every later request fails with it. */
  private endedBy: Error | undefined
  private signalEnded: (cause: Error | null) => void = () => undefined
  readonly ended = new Promise<Error | null>((resolve) => {
    this.signalEnded = resolve
  })

  constructor(private readonly transport: ClientTransport) {
    this.timers = transport.timers ?? systemTimers
  }

  get isEnded(): boolean {
    return this.endedBy !== undefined
  }

  request<M extends Method>(
    method: M,
    params: Methods[M]["params"],
    options?: RequestOptions,
  ): Promise<Methods[M]["result"]> {
    return new Promise((resolve, reject) => {
      if (this.endedBy !== undefined) {
        reject(this.endedBy)
        return
      }
      if (this.pending.size >= CLIENT_PENDING_REQUESTS_MAX) {
        reject(new ProtocolError(ErrorCode.ResourceExhausted, "Too many pending requests"))
        return
      }
      const signal = options?.signal
      if (signal?.aborted === true) {
        reject(cancelled())
        return
      }
      const id = ++this.lastRequestId
      const timeoutMs = options?.timeoutMs ?? replyTimeoutMs(method, params)
      const abandon = () => {
        if (this.take(id) !== undefined) {
          this.sendCancel(id)
          reject(cancelled())
        }
      }
      const settled = () => signal?.removeEventListener("abort", abandon)
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id)
        settled()
        reject(new Error(`No reply to ${method} within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        timer,
        // `settle` has run this method's result parser on it first.
        resolve: (result) => {
          settled()
          resolve(result as Methods[M]["result"])
        },
        reject: (error) => {
          settled()
          reject(error)
        },
      })
      signal?.addEventListener("abort", abandon, { once: true })
      try {
        this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      } catch (error: unknown) {
        this.take(id)
        settled()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Best effort: if it cannot be sent, the server's own deadline still ends the work. */
  private sendCancel(id: number): void {
    try {
      this.transport.send(
        JSON.stringify({ jsonrpc: "2.0", method: CANCEL_NOTIFICATION, params: { id } }),
      )
    } catch (error: unknown) {
      const report = this.transport.onBackgroundError ?? reportToConsole
      report(error)
    }
  }

  onEvent(listener: EventListener): () => void {
    if (this.listeners.size >= CLIENT_LISTENERS_MAX) {
      throw new ProtocolError(ErrorCode.ResourceExhausted, "Too many event listeners")
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A server that sends nonsense cannot be trusted with later requests either. */
  receive(line: string): void {
    try {
      this.deliver(parseServerMessage(JSON.parse(line)))
    } catch (error: unknown) {
      this.fail(new Error(`Invalid message from server: ${boundedText(String(error))}`))
    }
  }

  /** The transport has gone. This is terminal. */
  fail(error: Error): void {
    this.end(error, error)
  }

  close(): void {
    this.end(new Error("Client is closed"), null)
  }

  private end(error: Error, cause: Error | null): void {
    if (this.endedBy !== undefined) {
      return
    }
    this.endedBy = error
    for (const { reject, timer } of this.pending.values()) {
      this.timers.clearTimeout(timer)
      reject(error)
    }
    this.pending.clear()
    this.listeners.clear()
    this.transport.close?.()
    this.signalEnded(cause)
  }

  private deliver(message: ServerMessage): void {
    switch (message.kind) {
      case "event":
        for (const listener of this.listeners) {
          this.notify(listener, message.event, message.subscriptionId)
        }
        return
      case "result": {
        const waiter = this.take(message.id)
        if (waiter !== undefined) {
          this.settle(waiter, message.result)
        }
        return
      }
      case "failure": {
        const { code, message: text, data } = message
        this.take(message.id)?.reject(protocolErrorFrom(code, text, data))
        return
      }
      default:
        assertNever(message)
    }
  }

  /** The listener's own failure says nothing about the server, so it does not end this. */
  private notify(listener: EventListener, event: RuntimeEvent, subscriptionId: string): void {
    try {
      listener(event, subscriptionId)
    } catch (error: unknown) {
      const report = this.transport.onBackgroundError ?? reportToConsole
      report(error)
    }
  }

  private settle(waiter: Pending, result: unknown): void {
    try {
      waiter.resolve(resultParsers[waiter.method](result, "result"))
    } catch (error: unknown) {
      waiter.reject(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  /** A reply can legitimately arrive after its request timed out. */
  private take(id: number): Pending | undefined {
    const waiter = this.pending.get(id)
    if (waiter !== undefined) {
      this.timers.clearTimeout(waiter.timer)
      this.pending.delete(id)
    }
    return waiter
  }
}

/**
 * In-process client that still round-trips every message through JSON, so
 * tests exercise exactly what a remote peer would see.
 */
export const createLoopbackClient = (controller: Controller): Client => {
  const connection = createConnection(controller, (line) => {
    queueMicrotask(() => client.receive(line))
  })
  const client = createClient({
    send: (line) => queueMicrotask(() => connection.receive(line)),
    close: () => connection.close(),
  })
  return client
}
