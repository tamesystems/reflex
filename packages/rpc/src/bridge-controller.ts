import {
  assert,
  BRIDGE_APP_WAIT_MS,
  BRIDGE_UNROUTED_EVENTS_MAX,
  BRIDGE_WAITERS_MAX,
  ErrorCode,
  type EventCursor,
  type Methods,
  ProtocolError,
  type RuntimeEvent,
  SUBSCRIBERS_MAX,
  type SubscribeResult,
} from "@reflex/protocol"
import {
  type BackgroundReporter,
  type Controller,
  type ControllerMethod,
  type ControllerSubscription,
  reportToConsole,
  systemTimers,
  type Timers,
} from "@reflex/runtime"
import type { Client } from "./client.ts"

export interface BridgeControllerOptions {
  /** What a caller is told when no app has connected in time: how to connect one. */
  readonly disconnectedMessage: string
  readonly appWaitMs?: number
  readonly timers?: Timers
  readonly onBackgroundError?: BackgroundReporter
  /** Releases whatever apps dial in through, once the controller has closed. */
  readonly onClose?: () => void
}

/**
 * A controller for an app that lives somewhere else and dials in. It forwards each
 * request to whichever app is connected, so every client of a controller (the CLI, a
 * journey, an agent) drives a live app exactly as it drives a headless one.
 */
export interface BridgeController extends Controller {
  /** Everything goes to this app from now on. The one before it, if any, is closed. */
  attach(client: Client): void
  /** This app's connection has gone. Ignored once it has been replaced. */
  detach(client: Client): void
  readonly connected: boolean
}

export const createBridgeController = (options: BridgeControllerOptions): BridgeController =>
  new RemoteController(options)

interface Subscriber {
  readonly listener: (event: RuntimeEvent) => void
  /** How far its events have reached. Null until its first subscribe has answered. */
  cursor: EventCursor | null
  closed: boolean
}

interface Waiter {
  resolve(peer: Peer): void
  reject(error: Error): void
}

/** One app connection, and the subscriptions it holds for this controller. */
class Peer {
  readonly routes = new Map<string, Subscriber>()
  /** Events that beat their subscription's reply here, kept until it arrives. */
  readonly unrouted: Array<{ readonly subscriptionId: string; readonly event: RuntimeEvent }> = []
  pendingSubscribeCount = 0
  stopEvents: () => void = () => undefined

  constructor(readonly client: Client) {}
}

class RemoteController implements BridgeController {
  private peer: Peer | null = null
  private closed = false
  private readonly subscribers = new Set<Subscriber>()
  private readonly waiters = new Set<Waiter>()
  private readonly timers: Timers
  private readonly report: BackgroundReporter
  private readonly appWaitMs: number

  constructor(private readonly options: BridgeControllerOptions) {
    this.timers = options.timers ?? systemTimers
    this.report = options.onBackgroundError ?? reportToConsole
    this.appWaitMs = options.appWaitMs ?? BRIDGE_APP_WAIT_MS
    assert(this.appWaitMs > 0, "a wait for an app ends")
  }

  get connected(): boolean {
    return this.peer !== null
  }

  attach(client: Client): void {
    if (this.closed) {
      client.close()
      return
    }
    const previous = this.peer
    const peer = new Peer(client)
    peer.stopEvents = client.onEvent((event, subscriptionId) =>
      this.route(peer, event, subscriptionId),
    )
    this.peer = peer
    if (previous !== null) {
      this.release(previous)
    }
    for (const waiter of this.waiters) {
      waiter.resolve(peer)
    }
    this.waiters.clear()
    // Each resumes after the last event it saw. An app that reloaded has a new session,
    // so its cursor means nothing there and it is told to resynchronize.
    for (const subscriber of this.subscribers) {
      if (subscriber.cursor !== null) {
        this.resume(peer, subscriber, subscriber.cursor)
      }
    }
  }

  detach(client: Client): void {
    const { peer } = this
    if (peer?.client === client) {
      this.peer = null
      this.release(peer)
    }
  }

  async request<M extends ControllerMethod>(
    method: M,
    params: Methods[M]["params"],
    options?: { readonly signal?: AbortSignal },
  ): Promise<Methods[M]["result"]> {
    const signal = options?.signal
    const peer = await this.awaitPeer(signal)
    try {
      // The caller going away is passed on, so the app stops waiting for it too.
      return await peer.client.request(method, params, signal === undefined ? {} : { signal })
    } catch (error: unknown) {
      throw this.failureFrom(error, peer)
    }
  }

  async subscribe(
    listener: (event: RuntimeEvent) => void,
    options?: { readonly since?: EventCursor },
  ): Promise<ControllerSubscription> {
    if (this.subscribers.size >= SUBSCRIBERS_MAX) {
      throw new ProtocolError(ErrorCode.ResourceExhausted, "Too many subscribers")
    }
    const peer = await this.awaitPeer(undefined)
    const subscriber: Subscriber = { listener, cursor: null, closed: false }
    this.subscribers.add(subscriber)
    try {
      const { sessionId, sequence } = await this.open(peer, subscriber, options?.since)
      return { unsubscribe: () => this.unsubscribe(subscriber), sessionId, sequence }
    } catch (error: unknown) {
      this.subscribers.delete(subscriber)
      throw this.failureFrom(error, peer)
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.options.onClose?.()
    const { peer } = this
    this.peer = null
    if (peer !== null) {
      this.release(peer)
    }
    this.subscribers.clear()
    for (const waiter of this.waiters) {
      waiter.reject(this.closedError())
    }
    this.waiters.clear()
  }

  private async open(
    peer: Peer,
    subscriber: Subscriber,
    since: EventCursor | undefined,
  ): Promise<SubscribeResult> {
    // A first subscribe has no cursor yet, so an app attached meanwhile skipped it.
    const first = subscriber.cursor === null
    peer.pendingSubscribeCount++
    try {
      const result = await peer.client.request(
        "app.subscribe",
        since === undefined ? {} : { since },
      )
      if (subscriber.closed) {
        this.forget(peer, result.subscriptionId)
        return result
      }
      if (this.peer !== peer) {
        // Its reply beat the replacement: carry it over from where this app left it.
        // A resume was already started by `attach`, and needs nothing more.
        if (first) {
          subscriber.cursor = { sessionId: result.sessionId, sequence: result.sequence }
          if (this.peer !== null) {
            this.resume(this.peer, subscriber, subscriber.cursor)
          }
        }
        return result
      }
      subscriber.cursor = { sessionId: result.sessionId, sequence: result.sequence }
      peer.routes.set(result.subscriptionId, subscriber)
      this.flushUnrouted(peer, result.subscriptionId)
      return result
    } finally {
      peer.pendingSubscribeCount--
      assert(peer.pendingSubscribeCount >= 0, "each subscribe is counted once")
      if (peer.pendingSubscribeCount === 0) {
        // Whatever is left belongs to no subscription here.
        peer.unrouted.length = 0
      }
    }
  }

  /** A subscriber the new app refuses is dropped, and that is reported. */
  private resume(peer: Peer, subscriber: Subscriber, since: EventCursor): void {
    this.open(peer, subscriber, since).catch((error: unknown) => {
      if (this.peer !== peer) {
        return // The next app will be asked instead.
      }
      this.subscribers.delete(subscriber)
      this.report(error)
    })
  }

  private unsubscribe(subscriber: Subscriber): void {
    subscriber.closed = true
    this.subscribers.delete(subscriber)
    const { peer } = this
    if (peer === null) {
      return
    }
    for (const [subscriptionId, routed] of peer.routes) {
      if (routed === subscriber) {
        this.forget(peer, subscriptionId)
      }
    }
  }

  /** An app that has gone has forgotten it already, so a failure here means nothing. */
  private forget(peer: Peer, subscriptionId: string): void {
    peer.routes.delete(subscriptionId)
    peer.client.request("app.unsubscribe", { subscriptionId }).catch(() => undefined)
  }

  private route(peer: Peer, event: RuntimeEvent, subscriptionId: string): void {
    const subscriber = peer.routes.get(subscriptionId)
    if (subscriber !== undefined) {
      this.deliver(subscriber, event)
      return
    }
    if (peer.pendingSubscribeCount === 0) {
      return
    }
    if (peer.unrouted.length >= BRIDGE_UNROUTED_EVENTS_MAX) {
      // Holding more would be unbounded, and dropping any would lose events silently. Letting
      // this app go makes it dial again, and its subscriptions resume from their cursors.
      this.report(new Error("The app sent too many events ahead of their subscription"))
      this.detach(peer.client)
      return
    }
    peer.unrouted.push({ subscriptionId, event })
  }

  private flushUnrouted(peer: Peer, subscriptionId: string): void {
    const subscriber = peer.routes.get(subscriptionId)
    if (subscriber === undefined) {
      return
    }
    const held = peer.unrouted.filter((entry) => entry.subscriptionId === subscriptionId)
    const rest = peer.unrouted.filter((entry) => entry.subscriptionId !== subscriptionId)
    peer.unrouted.length = 0
    peer.unrouted.push(...rest)
    for (const { event } of held) {
      this.deliver(subscriber, event)
    }
  }

  private deliver(subscriber: Subscriber, event: RuntimeEvent): void {
    if (subscriber.closed) {
      return
    }
    subscriber.cursor = { sessionId: event.sessionId, sequence: event.sequence }
    try {
      subscriber.listener(event)
    } catch (error: unknown) {
      this.report(error)
    }
  }

  private release(peer: Peer): void {
    peer.stopEvents()
    peer.routes.clear()
    peer.unrouted.length = 0
    peer.client.close()
  }

  private awaitPeer(signal: AbortSignal | undefined): Promise<Peer> {
    if (this.closed) {
      return Promise.reject(this.closedError())
    }
    if (signal?.aborted === true) {
      return Promise.reject(new ProtocolError(ErrorCode.SessionClosed, "The caller has gone"))
    }
    if (this.peer !== null) {
      return Promise.resolve(this.peer)
    }
    if (this.waiters.size >= BRIDGE_WAITERS_MAX) {
      const message = "Too many requests are waiting for an app to connect"
      return Promise.reject(new ProtocolError(ErrorCode.ResourceExhausted, message))
    }
    return new Promise<Peer>((resolve, reject) => {
      const finish = () => {
        this.timers.clearTimeout(timer)
        signal?.removeEventListener("abort", abandon)
        this.waiters.delete(waiter)
      }
      const waiter: Waiter = {
        resolve: (peer) => {
          finish()
          resolve(peer)
        },
        reject: (error) => {
          finish()
          reject(error)
        },
      }
      const timer = this.timers.setTimeout(
        () =>
          waiter.reject(
            new ProtocolError(ErrorCode.SessionClosed, this.options.disconnectedMessage),
          ),
        this.appWaitMs,
      )
      const abandon = () =>
        waiter.reject(new ProtocolError(ErrorCode.SessionClosed, "The caller has gone"))
      signal?.addEventListener("abort", abandon, { once: true })
      this.waiters.add(waiter)
    })
  }

  /**
   * The app's own refusals pass through as they are. Losing the app mid-request is not
   * the caller's mistake, and they cannot know whether the request took effect.
   */
  private failureFrom(error: unknown, peer: Peer): Error {
    if (error instanceof ProtocolError) {
      return error
    }
    if (this.peer !== peer || peer.client.isEnded) {
      const message = "The app disconnected before it answered, so this may or may not have run"
      return new ProtocolError(ErrorCode.SessionClosed, message)
    }
    const message = error instanceof Error ? error.message : String(error)
    return new ProtocolError(ErrorCode.WaitTimeout, `The app did not answer: ${message}`)
  }

  private closedError(): ProtocolError {
    return new ProtocolError(ErrorCode.SessionClosed, "This bridge has been closed")
  }
}
