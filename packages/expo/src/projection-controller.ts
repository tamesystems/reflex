import { assert, assertNever, defined, type OperationInfo } from "@reflex/protocol"
import {
  type Applied,
  type Destination,
  initialApplied,
  interpret,
  type RouterCommand,
  type RouterLocation,
  sameDestination,
  sameLocation,
  type StackEntry,
  syncRouter,
} from "./projection.ts"

/**
 * How long the router may take to show any sign of where it was sent. Each action it
 * accepts is reported, so a push undone before it ever shows is seen without waiting
 * for this. It is the backstop for a command the router drops without saying so.
 */
export const ROUTER_ARRIVAL_TIMEOUT_MS = 500
/**
 * A deadline this late measures a blocked JavaScript thread, not the router: its queued
 * work has not had a turn yet, so the wait starts again.
 */
export const ROUTER_DEADLINE_LATENESS_MAX_MS = 100
/** A router that says it arrived but never reports it is taken at its report in the end. */
const ROUTER_ARRIVAL_RECHECKS_MAX = 20

/** What the projection needs from the router. */
export interface RouterPort {
  push(entry: StackEntry): void
  replace(entry: StackEntry): void
  tag(entry: StackEntry): void
  back(): void
  /** The token its own state holds now, which a report of it can lag behind. */
  shownToken(): string | null
}

/** What the projection needs from the core. */
export interface CorePort {
  /** False once the session has ended; results arriving later touch nothing. */
  isOpen(): boolean
  readStack(): ReadonlyArray<StackEntry>
  goBack(): Promise<OperationInfo>
  navigate(destination: Destination): Promise<OperationInfo>
}

export interface ProjectionOptions {
  readonly router: RouterPort
  readonly core: CorePort
  readonly initialLocation: RouterLocation
  readonly onError: (error: unknown) => void
  /** Run `callback` later, returning how to cancel it. Injected so tests own time. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void
  /** Milliseconds on a monotonic clock, to tell a late deadline from a slow router. */
  readonly now: () => number
}

type Phase =
  | { readonly kind: "idle" }
  /** The router has moved back and the core is catching up, one step at a time. */
  | { readonly kind: "returning"; readonly from: RouterLocation }
  /** The router shows a destination that the core has been asked to open. */
  | {
      readonly kind: "adopting"
      readonly destination: Destination
      readonly from: RouterLocation
    }

/** What the router was told to do and has not yet been seen to finish. */
interface Outbound {
  /** Where it was. Hearing this again only means it has not moved yet. */
  readonly origin: RouterLocation
  /** Where it was sent. */
  readonly expected: RouterLocation
  /** Where the commands pass through on the way, which is not user input either. */
  readonly transit: ReadonlyArray<RouterLocation>
  cancelDeadline: () => void
}

/**
 * The one place navigation state is owned. It lives as long as the session: React
 * may re-run effects without any dependency changing, so both entry points must
 * be safe to repeat. Inbound work runs one at a time, and whatever the router
 * does meanwhile is read from `location` when it finishes.
 */
export class ProjectionController {
  private phase: Phase = { kind: "idle" }
  private outbound: Outbound | null = null
  private applied: ReadonlyArray<Applied> | null = null
  private location: RouterLocation

  constructor(private readonly options: ProjectionOptions) {
    this.location = options.initialLocation
  }

  onStack(stack: ReadonlyArray<StackEntry>): void {
    if (this.phase.kind !== "returning") {
      this.sync(stack)
    }
  }

  /**
   * Where the router is: after each action it accepted, and again after each render.
   * Several actions can land in one render, so only the first source sees a push and
   * the back that undoes it. Hearing a location twice is harmless.
   */
  onLocation(location: RouterLocation): void {
    this.location = location
    if (this.isOutboundProgress(location)) {
      return
    }
    if (this.phase.kind === "idle") {
      this.considerLocation()
    }
  }

  /** Is this the router carrying out a command, rather than something new? */
  private isOutboundProgress(location: RouterLocation): boolean {
    const { outbound } = this
    if (outbound === null) {
      return false
    }
    if (sameLocation(location, outbound.expected)) {
      this.endOutbound()
      return true
    }
    if (sameLocation(location, outbound.origin)) {
      return true
    }
    if (outbound.transit.some((step) => sameLocation(location, step))) {
      return true
    }
    this.endOutbound()
    return false
  }

  private endOutbound(): void {
    this.outbound?.cancelDeadline()
    this.outbound = null
  }

  /** Returns whether the router was told to move. */
  private sync(stack: ReadonlyArray<StackEntry>): boolean {
    const [root] = stack
    if (root === undefined || !this.options.core.isOpen()) {
      return false
    }
    this.applied ??= initialApplied(root, this.location)
    const before = this.applied
    const result = syncRouter(before, stack, this.adoption())
    this.applied = result.applied
    if (result.commands.length === 0) {
      return false
    }
    this.expectArrival(before, result.applied, result.commands)
    result.commands.forEach((command) => {
      this.execute(command)
    })
    return true
  }

  /** An adoption the user has moved on from is no longer on screen to be tagged. */
  private adoption() {
    if (this.phase.kind !== "adopting") {
      return null
    }
    const { destination } = this.phase
    const shown = this.location.destination
    const onScreen = shown !== null && sameDestination(shown, destination)
    return { destination, onScreen }
  }

  private expectArrival(
    before: ReadonlyArray<Applied>,
    after: ReadonlyArray<Applied>,
    commands: ReadonlyArray<RouterCommand>,
  ): void {
    this.endOutbound()
    const top = defined(after.at(-1), "the root is never popped")
    this.outbound = {
      origin: this.location,
      expected: { token: top.token, destination: destinationOf(top.entry) },
      transit: stepsThrough(before, commands),
      cancelDeadline: this.arrivalDeadline(ROUTER_ARRIVAL_RECHECKS_MAX),
    }
  }

  private arrivalDeadline(rechecksLeft: number): () => void {
    const dueAt = this.options.now() + ROUTER_ARRIVAL_TIMEOUT_MS
    return this.options.schedule(
      () => this.onArrivalOverdue(rechecksLeft, this.options.now() - dueAt),
      ROUTER_ARRIVAL_TIMEOUT_MS,
    )
  }

  private onArrivalOverdue(rechecksLeft: number, latenessMs: number): void {
    const { router, core } = this.options
    const outbound = this.outbound
    if (!core.isOpen()) {
      this.outbound = null
      return
    }
    // A blocked thread: the router's queued work runs after this, so give it its turn.
    const stalled = latenessMs > ROUTER_DEADLINE_LATENESS_MAX_MS
    // A screen slow to render: it is there, and its report is on the way.
    const arrived = router.shownToken() === outbound?.expected.token
    if (outbound !== null && rechecksLeft > 0 && (stalled || arrived)) {
      outbound.cancelDeadline = this.arrivalDeadline(rechecksLeft - 1)
      return
    }
    this.outbound = null
    if (this.phase.kind === "idle") {
      this.considerLocation()
    }
  }

  private execute(command: RouterCommand): void {
    const { router } = this.options
    switch (command.type) {
      case "push":
        router.push(command.entry)
        break
      case "replace":
        router.replace(command.entry)
        break
      case "tag":
        router.tag(command.entry)
        break
      case "back":
        for (let step = 0; step < command.count; step++) {
          router.back()
        }
        break
      default:
        assertNever(command)
    }
  }

  private considerLocation(): void {
    if (this.applied === null) {
      return
    }
    const command = interpret(this.applied, this.location)
    const { onError } = this.options
    switch (command.type) {
      case "none":
        return
      case "goBack":
        this.applied = this.applied.slice(0, this.applied.length - command.count)
        this.phase = { kind: "returning", from: this.location }
        this.returnBy(command.count).catch(onError)
        return
      case "navigate":
        this.phase = {
          kind: "adopting",
          destination: command.destination,
          from: this.location,
        }
        this.adopt(command.destination).catch(onError)
        return
      default:
        assertNever(command)
    }
  }

  /** A failed operation is an answer, not a rejection, so nothing else will say so. */
  private reportDefect(operation: OperationInfo): void {
    if (operation.status === "failed" && operation.error.defect) {
      this.options.onError(new Error(`${operation.action} crashed: ${operation.error.message}`))
    }
  }

  private async returnBy(stepCount: number): Promise<void> {
    try {
      for (let step = 0; step < stepCount; step++) {
        const operation = await this.options.core.goBack()
        this.reportDefect(operation)
        if (operation.status !== "completed") {
          break
        }
      }
    } finally {
      this.finishInbound()
    }
  }

  private async adopt(destination: Destination): Promise<void> {
    let landed = false
    try {
      const operation = await this.options.core.navigate(destination)
      this.reportDefect(operation)
      landed = operation.status === "completed"
    } finally {
      if (landed) {
        this.finishInbound()
      } else if (this.options.core.isOpen()) {
        // The core refused, so the router must not keep showing that place.
        this.phase = { kind: "idle" }
        this.showTop()
      }
    }
  }

  /**
   * Wherever the core ended up is the truth, even if it refused to move. This
   * syncs before going idle, because React may not have delivered the new stack
   * yet, and an adoption must still be recognized as one when it arrives.
   */
  private finishInbound(): void {
    const { phase } = this
    assert(phase.kind !== "idle", "inbound work finishes from an inbound phase")
    const moved = this.sync(this.options.core.readStack())
    this.phase = { kind: "idle" }
    // Only a location that moved meanwhile is news: acting on the same one again
    // would repeat what has just finished, and that would never end.
    if (!moved && !sameLocation(this.location, phase.from)) {
      this.considerLocation()
    }
  }

  private showTop(): void {
    const applied = defined(this.applied ?? undefined, "adoption starts from an applied stack")
    const top = defined(applied.at(-1), "the root is never popped")
    const tagged: Applied = { entry: top.entry, token: top.entry.nodeId, inRouter: true }
    const next = [...applied.slice(0, -1), tagged]
    this.applied = next
    const replace: RouterCommand = { type: "replace", entry: top.entry }
    this.expectArrival(applied, next, [replace])
    this.execute(replace)
  }
}

const destinationOf = ({ route, params }: Destination): Destination => ({ route, params })

const locationOf = (entry: StackEntry): RouterLocation => ({
  token: entry.nodeId,
  destination: destinationOf(entry),
})

/**
 * Every location the router shows while it carries out `commands`, one action at a
 * time. Exactly these, and no more: a screen beneath that it was not sent to is the
 * user going back, even if it was on the stack before.
 */
const stepsThrough = (
  before: ReadonlyArray<Applied>,
  commands: ReadonlyArray<RouterCommand>,
): ReadonlyArray<RouterLocation> => {
  const history: Array<RouterLocation> = before
    .filter(({ inRouter }) => inRouter)
    .map(({ entry, token }) => ({ token, destination: destinationOf(entry) }))
  const steps: Array<RouterLocation> = []
  const replaceTop = (location: RouterLocation) => {
    history.splice(-1, 1, location)
  }
  for (const command of commands) {
    switch (command.type) {
      case "back":
        for (let step = 0; step < command.count; step++) {
          history.pop()
          const top = history.at(-1)
          if (top !== undefined) {
            steps.push(top)
          }
        }
        continue
      case "push":
        history.push(locationOf(command.entry))
        break
      case "replace":
        replaceTop(locationOf(command.entry))
        break
      case "tag": {
        const top = history.at(-1)
        replaceTop({ token: command.entry.nodeId, destination: top?.destination ?? null })
        break
      }
      default:
        assertNever(command)
    }
    steps.push(defined(history.at(-1), "a command leaves something on screen"))
  }
  return steps
}
