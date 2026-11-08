import {
  type AccessPolicy,
  assert,
  FULL_CONTROL,
  requirePermitted,
  BATCH_LARGE_REPLY_CHARACTERS_MAX,
  BATCH_REQUESTS_MAX,
  boundedText,
  CONNECTION_REQUESTS_MAX,
  CONNECTION_SUBSCRIPTIONS_MAX,
  CANCEL_NOTIFICATION,
  ErrorCode,
  EVENT_NOTIFICATION,
  FRAME_CHARACTERS_MAX,
  HELD_EVENT_CHARACTERS_MAX,
  isRecord,
  type Json,
  measureJson,
  type Method,
  paramParsers,
  ProtocolError,
  REQUEST_ID_CHARACTERS_MAX,
  RETAINED_EVENTS_MAX,
  type RuntimeEvent,
  SMALL_REPLY_CHARACTERS_MAX,
} from "@reflex/protocol"
import {
  type BackgroundReporter,
  type Controller,
  type ControllerMethod,
  reportToConsole,
  restrictController,
} from "@reflex/runtime"

/** Room for the envelope around an event. */
const NOTIFICATION_CHARACTERS_MAX = FRAME_CHARACTERS_MAX - 1024

export interface Connection {
  /** Handle one newline-delimited JSON-RPC message. */
  receive(line: string): void
  /** Settles once every reply so far has been handed to `send`. */
  drained(): Promise<void>
  close(): void
}

/**
 * An event goes to every subscriber in turn, so the last one is kept encoded. Only
 * the last: keeping one per event would double what the event log retains. Whoever
 * serves the connections owns this, for as long as they do.
 */
export const createEventEncoder = (report: BackgroundReporter = reportToConsole) => {
  let last: { readonly event: RuntimeEvent; readonly encoded: string | null } | null = null
  return (event: RuntimeEvent): string | null => {
    if (last?.event === event) {
      return last.encoded
    }
    const encoding = encodedForTheWire(event)
    if (encoding.kind === "not-json") {
      report(new Error(`A "${event.type}" event is not JSON, so it cannot be sent`))
    }
    const line = encoding.kind === "encoded" ? encoding.line : null
    const encoded = line !== null && line.length <= NOTIFICATION_CHARACTERS_MAX ? line : null
    last = { event, encoded }
    return encoded
  }
}

export interface ConnectionOptions {
  /** Enables `session.shutdown` for this peer. Offer only to the session's owner. */
  readonly onShutdown?: () => void
  /** Failures with no request to answer. */
  readonly onBackgroundError?: BackgroundReporter
  /** Share one between connections, to encode each event once. */
  readonly encodeEvent?: (event: RuntimeEvent) => string | null
  /** What this peer may do. Full control unless given; `session.shutdown` needs it too. */
  readonly access?: AccessPolicy
}

export const createConnection = (
  controller: Controller,
  send: (line: string) => void,
  options: ConnectionOptions = {},
): Connection =>
  new PeerConnection(restrictController(controller, options.access ?? FULL_CONTROL), send, options)

type Id = string | number | null

type SubscribeParams = ReturnType<(typeof paramParsers)["app.subscribe"]>

type Delivery = "single" | "batched"

/** One reply on its way, and the work that has to wait until it is out. */
interface Reply {
  readonly delivery: Delivery
  readonly afterwards: Array<() => void>
}

const replyFor = (delivery: Delivery): Reply => ({ delivery, afterwards: [] })

/** What a connection's held events add up to, across its subscriptions. */
interface HeldBudget {
  characterCount: number
}

/**
 * Events for a subscription whose reply has not gone out, and that may wait on a long
 * request in the same batch. No more than the event log keeps, and no more than the write
 * queue can take, if it is otherwise empty, when they are released. Past that, a peer that
 * was going to lose events is told to resynchronize instead.
 */
class HeldEvents {
  private events: Array<RuntimeEvent> = []
  private characterCount = 0
  private latestLost: RuntimeEvent | null = null

  constructor(private readonly budget: HeldBudget) {}

  hold(event: RuntimeEvent, characterCount: number): void {
    if (this.latestLost !== null) {
      this.latestLost = event
      return
    }
    this.events.push(event)
    this.characterCount += characterCount
    this.budget.characterCount += characterCount
    if (
      this.events.length > RETAINED_EVENTS_MAX ||
      this.budget.characterCount > HELD_EVENT_CHARACTERS_MAX
    ) {
      this.latestLost = event
      this.events = []
      this.giveBackBudget()
    }
  }

  private giveBackBudget(): void {
    this.budget.characterCount -= this.characterCount
    this.characterCount = 0
  }

  /** Empties it, and returns what the peer should now be sent. */
  release(): ReadonlyArray<RuntimeEvent> {
    const events = this.events
    const latestLost = this.latestLost
    this.events = []
    this.latestLost = null
    this.giveBackBudget()
    if (latestLost === null) {
      return events
    }
    const { sessionId, sequence, revision } = latestLost
    return [{ type: "resync.required", sessionId, sequence, revision }]
  }
}

interface Failure {
  readonly jsonrpc: "2.0"
  readonly id: Id
  readonly error: { readonly code: number; readonly message: string; readonly data?: Json }
}

const failure = (id: Id, code: number, message: string, data?: Json): Failure => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
})

const isValidId = (id: unknown): id is Id | undefined => {
  switch (typeof id) {
    case "undefined":
      return true
    case "number":
      return Number.isFinite(id)
    case "string":
      return id.length <= REQUEST_ID_CHARACTERS_MAX
    default:
      return id === null
  }
}

const isMethod = (method: string): method is Method => Object.hasOwn(paramParsers, method)

/**
 * Speaks JSON-RPC 2.0 for one peer. Requests run concurrently so that a long
 * `app.wait` cannot block the `app.advanceTime` that would satisfy it, up to
 * `CONNECTION_REQUESTS_MAX` at once.
 */
class PeerConnection implements Connection {
  private readonly subscriptions = new Map<string, () => void>()
  /** Ends this peer's pending waits when it goes away. */
  private readonly lifetime = new AbortController()
  /**
   * Each request in flight that has an id, so the peer can cancel it alone. Bounded by
   * `CONNECTION_REQUESTS_MAX`; a repeated id cancels only the latest of its requests.
   */
  private readonly cancellable = new Map<string | number, AbortController>()
  private lastSubscriptionIndex = 0
  /** Held from before the await, so concurrent requests cannot overshoot the limit. */
  private reservedSubscriptionCount = 0
  private requestCount = 0
  /** Longer than `requestCount`: a batch's reply waits for all of its requests. */
  private unwrittenReplyCount = 0
  private readonly drainWaiters: Array<() => void> = []
  private readonly heldBudget: HeldBudget = { characterCount: 0 }
  private readonly encodeEvent: (event: RuntimeEvent) => string | null

  constructor(
    private readonly controller: Controller,
    private readonly send: (line: string) => void,
    private readonly options: ConnectionOptions,
  ) {
    this.encodeEvent = options.encodeEvent ?? createEventEncoder(this.reportBackground)
  }

  drained(): Promise<void> {
    if (this.unwrittenReplyCount === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve)
    })
  }

  receive(line: string): void {
    if (line.trim() === "") {
      return
    }
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      // The peer's mistake, and answering it is the handling.
      this.write(failure(null, ErrorCode.ParseError, "Parse error"))
      return
    }
    if (Array.isArray(message)) {
      this.receiveBatch(message)
    } else {
      const reply = replyFor("single")
      this.finishing(
        this.handle(message, reply).then((response) => {
          this.writeIfAny(response)
          runAfterwards(reply)
        }),
      )
    }
  }

  close(): void {
    this.lifetime.abort()
    this.cancellable.clear()
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe()
    }
    this.subscriptions.clear()
  }

  private get closed(): boolean {
    return this.lifetime.signal.aborted
  }

  private receiveBatch(messages: ReadonlyArray<unknown>): void {
    if (messages.length === 0) {
      this.write(failure(null, ErrorCode.InvalidRequest, "Empty batch"))
      return
    }
    if (messages.length > BATCH_REQUESTS_MAX) {
      this.write(failure(null, ErrorCode.InvalidRequest, `Batch over ${BATCH_REQUESTS_MAX}`))
      return
    }
    // Bounded by the check above, so all of them can run at once.
    const reply = replyFor("batched")
    this.finishing(
      Promise.all(messages.map((message) => this.handle(message, reply))).then((responses) => {
        const replies = responses.filter((response) => response !== undefined)
        if (replies.length > 0) {
          this.writeBatch(replies)
        }
        runAfterwards(reply)
      }),
    )
  }

  private finishing(writing: Promise<void>): void {
    this.unwrittenReplyCount++
    writing
      .catch((error: unknown) => this.reportBackground(error))
      .finally(() => {
        this.unwrittenReplyCount--
        assert(this.unwrittenReplyCount >= 0, "each reply is counted once")
        if (this.unwrittenReplyCount === 0) {
          this.resolveDrainWaiters()
        }
      })
      .catch((error: unknown) => this.reportBackground(error))
  }

  /** Resolves to the response, or undefined for a notification. */
  private async handle(message: unknown, reply: Reply): Promise<unknown> {
    if (!isRecord(message)) {
      return failure(null, ErrorCode.InvalidRequest, "Invalid request")
    }
    const { id, method, params, jsonrpc } = message
    if (!isValidId(id)) {
      return failure(null, ErrorCode.InvalidRequest, "Invalid id")
    }
    const replyId = id ?? null
    if (jsonrpc !== "2.0" || typeof method !== "string") {
      return failure(replyId, ErrorCode.InvalidRequest, "Invalid request")
    }
    if (method === CANCEL_NOTIFICATION) {
      this.cancel(params)
      return id === undefined ? undefined : { jsonrpc: "2.0", id: replyId, result: { ok: true } }
    }
    if (this.requestCount >= CONNECTION_REQUESTS_MAX) {
      // A notification gets no reply, even a refusal.
      return id === undefined
        ? undefined
        : failure(replyId, ErrorCode.ResourceExhausted, "Too many requests in flight")
    }
    this.requestCount++
    // Ends with this request, with the peer, or when the peer cancels it.
    const scope = new AbortController()
    const abandon = () => scope.abort()
    this.lifetime.signal.addEventListener("abort", abandon, { once: true })
    if (replyId !== null) {
      this.cancellable.set(replyId, scope)
    }
    try {
      await Promise.resolve()
      // The peer may have gone while this call was queued.
      if (this.closed) {
        return undefined
      }
      const result = await this.call(method, params === undefined ? {} : params, reply, scope)
      return id === undefined ? undefined : { jsonrpc: "2.0", id: replyId, result }
    } catch (error: unknown) {
      return this.failureFor(error, id, replyId)
    } finally {
      this.lifetime.signal.removeEventListener("abort", abandon)
      if (replyId !== null && this.cancellable.get(replyId) === scope) {
        this.cancellable.delete(replyId)
      }
      this.requestCount--
      assert(this.requestCount >= 0, "each request is counted once")
    }
  }

  private failureFor(error: unknown, id: Id | undefined, replyId: Id): Failure | undefined {
    if (id === undefined) {
      if (!(error instanceof ProtocolError)) {
        this.reportBackground(error)
      }
      return undefined
    }
    if (error instanceof ProtocolError) {
      return failure(replyId, error.code, boundedText(error.message), error.data)
    }
    return failure(replyId, ErrorCode.InternalError, boundedText(String(error)))
  }

  private cancel(params: unknown): void {
    if (!isRecord(params) || !isValidId(params.id) || params.id === undefined) {
      return // A notification cannot be refused, and a malformed one names no request.
    }
    if (params.id !== null) {
      this.cancellable.get(params.id)?.abort()
    }
  }

  private call(
    method: string,
    params: unknown,
    reply: Reply,
    scope: AbortController,
  ): Promise<unknown> | unknown {
    if (!isMethod(method)) {
      throw new ProtocolError(ErrorCode.MethodNotFound, `Unknown method "${boundedText(method)}"`)
    }
    switch (method) {
      case "app.subscribe":
        return this.subscribe(paramParsers[method](params, "params"), reply)
      case "app.unsubscribe":
        return this.unsubscribe(paramParsers[method](params, "params").subscriptionId)
      case "session.shutdown":
        paramParsers[method](params, "params")
        return this.shutdown(reply)
      default:
        return this.forward(method, params, scope.signal)
    }
  }

  private forward<M extends ControllerMethod>(method: M, params: unknown, signal: AbortSignal) {
    const parser: (typeof paramParsers)[M] = paramParsers[method]
    return this.controller.request(method, parser(params, "params"), { signal })
  }

  private async subscribe(params: SubscribeParams, reply: Reply) {
    if (this.reservedSubscriptionCount >= CONNECTION_SUBSCRIPTIONS_MAX) {
      throw new ProtocolError(ErrorCode.ResourceExhausted, "Too many subscriptions")
    }
    this.reservedSubscriptionCount++
    try {
      return await this.openSubscription(params, reply)
    } catch (error: unknown) {
      this.reservedSubscriptionCount--
      assert(this.reservedSubscriptionCount >= 0, "each reservation is released once")
      throw error
    }
  }

  private async openSubscription(params: SubscribeParams, reply: Reply) {
    const subscriptionId = `sub-${++this.lastSubscriptionIndex}`
    // Events wait for the reply that names their subscription, including any replay,
    // or a peer that filters on the id would drop them.
    let held: HeldEvents | null = new HeldEvents(this.heldBudget)
    const { unsubscribe, sessionId, sequence } = await this.controller.subscribe((event) => {
      if (held === null) {
        this.writeEvent(event, subscriptionId)
      } else {
        held.hold(event, this.encodeEvent(event)?.length ?? FRAME_CHARACTERS_MAX)
      }
    }, params)
    if (this.closed) {
      unsubscribe()
      throw new ProtocolError(ErrorCode.SessionClosed, "Connection closed")
    }
    this.subscriptions.set(subscriptionId, () => {
      unsubscribe()
      held?.release()
    })
    reply.afterwards.push(() => {
      for (const event of held?.release() ?? []) {
        this.writeEvent(event, subscriptionId)
      }
      held = null
    })
    return { subscriptionId, sessionId, sequence }
  }

  private unsubscribe(subscriptionId: string): { readonly ok: true } {
    const unsubscribe = this.subscriptions.get(subscriptionId)
    if (unsubscribe !== undefined) {
      unsubscribe()
      this.subscriptions.delete(subscriptionId)
      this.reservedSubscriptionCount--
      assert(this.reservedSubscriptionCount >= 0, "each reservation is released once")
    }
    return { ok: true }
  }

  /** Not in a batch: its reply waits on siblings the shutdown would abandon. */
  private shutdown(reply: Reply): { readonly ok: true } {
    const { onShutdown } = this.options
    // The connection's own option and any restriction on the controller both apply.
    requirePermitted(this.controller.access ?? FULL_CONTROL, "session.shutdown")
    if (onShutdown === undefined || reply.delivery === "batched") {
      throw new ProtocolError(ErrorCode.MethodNotFound, `Unknown method "session.shutdown"`)
    }
    // After the reply, so that the caller learns it was accepted.
    reply.afterwards.push(onShutdown)
    return { ok: true }
  }

  private resolveDrainWaiters(): void {
    for (const resolve of this.drainWaiters.splice(0)) {
      resolve()
    }
  }

  private writeIfAny(response: unknown): void {
    if (response !== undefined) {
      this.write(response)
    }
  }

  /** An event too large to send is lost, and a peer that loses events must resynchronize. */
  private writeEvent(event: RuntimeEvent, subscriptionId: string): void {
    const encoded = this.encodeEvent(event)
    if (encoded !== null) {
      this.writeLine(notificationLine(subscriptionId, encoded))
      return
    }
    const { sessionId, sequence, revision } = event
    const resync: RuntimeEvent = { type: "resync.required", sessionId, sequence, revision }
    this.writeLine(notificationLine(subscriptionId, JSON.stringify(resync)))
  }

  /** What a client would refuse must not be sent: this is the limit's other half. */
  private write(message: unknown): void {
    const encoding = encodedForTheWire(message)
    this.writeLine(
      encoding.kind === "encoded" ? encoding.line : this.refusalLine(message, encoding),
    )
  }

  /** Too large is the peer's to hear of. Not being JSON is the app's mistake, and reported. */
  private refusalLine(reply: unknown, { kind }: Refusal): string {
    if (kind === "too-large") {
      return JSON.stringify(tooLarge(reply))
    }
    this.reportBackground(new Error("A reply is not JSON, so it cannot be sent"))
    return JSON.stringify(failure(idOf(reply), ErrorCode.InternalError, "The reply is not JSON"))
  }

  /**
   * Each reply keeps its id, so that its request is answered whatever the others do.
   * Replies are kept in order until their share runs out. A batch can ask for far more
   * than a frame, so of the encoded replies only those that will be sent are kept.
   */
  private writeBatch(replies: ReadonlyArray<unknown>): void {
    let largeCharacterCount = 0
    const lines = replies.map((reply) => {
      const encoding = encodedForTheWire(reply)
      if (encoding.kind !== "encoded") {
        return this.refusalLine(reply, encoding)
      }
      const { line } = encoding
      if (line.length <= SMALL_REPLY_CHARACTERS_MAX) {
        return line
      }
      if (largeCharacterCount + line.length <= BATCH_LARGE_REPLY_CHARACTERS_MAX) {
        largeCharacterCount += line.length
        return line
      }
      return JSON.stringify(tooLarge(reply))
    })
    this.writeLine(`[${lines.join(",")}]`)
  }

  private writeLine(line: string): void {
    if (!this.closed) {
      this.send(line)
    }
  }

  private readonly reportBackground = (error: unknown): void => {
    const report = this.options.onBackgroundError ?? reportToConsole
    report(error)
  }
}

const runAfterwards = ({ afterwards }: Reply): void => {
  for (const work of afterwards.splice(0)) {
    work()
  }
}

interface Refusal {
  readonly kind: "too-large" | "not-json"
}

type Encoding = { readonly kind: "encoded"; readonly line: string } | Refusal

/** Checked, then serialized once: the frames this is for can be megabytes. */
const encodedForTheWire = (message: unknown): Encoding => {
  const measure = measureJson(message, FRAME_CHARACTERS_MAX)
  if (measure !== "fits") {
    return { kind: measure === "not-json" ? "not-json" : "too-large" }
  }
  const line = JSON.stringify(message)
  // The count is a lower bound: escapes can take it over.
  return line.length <= FRAME_CHARACTERS_MAX ? { kind: "encoded", line } : { kind: "too-large" }
}

const notificationLine = (subscriptionId: string, encoded: string): string => {
  const params = `{"subscriptionId":${JSON.stringify(subscriptionId)},"event":${encoded}}`
  return `{"jsonrpc":"2.0","method":"${EVENT_NOTIFICATION}","params":${params}}`
}

const tooLarge = (reply: unknown): Failure =>
  failure(idOf(reply), ErrorCode.ResourceExhausted, "Reply exceeds the limits")

const idOf = (reply: unknown): Id => {
  if (!isRecord(reply)) {
    return null
  }
  const { id } = reply
  return typeof id === "string" || typeof id === "number" ? id : null
}
