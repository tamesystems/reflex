import {
  defined,
  ErrorCode,
  ProtocolError,
  type InspectResult,
  type Json,
  type NodeSnapshot,
  type OperationInfo,
  type RuntimeEvent,
  type WaitParams,
} from "@reflex/protocol"
import { type Client, createLoopbackClient } from "@reflex/rpc"
import {
  type AppHost,
  type ScenarioName,
  type Controller,
  type ConsumerDefinition,
  createController,
  definitionIdentity,
} from "@reflex/runtime/internal"

import { createJourneyClient, type JourneyClient } from "./journey-client.ts"

type DefinitionsOf<H> = H extends { readonly nodes: infer N }
  ? Extract<N[keyof N], ConsumerDefinition>
  : never
const JOURNEY_STEP_TIMEOUT_MS_DEFAULT = 2_000
/** A journey is short. More than this means something is looping. */
const OBSERVED_EVENTS_MAX = 20_000
/** Events carry whole states, so a count alone would not bound what a journey keeps. */
const OBSERVED_EVENT_CHARACTERS_MAX = 64 * 1024 * 1024
const CONDITION_TIMEOUT_MS = 2_000
const CONDITION_POLL_MS = 1

export interface TestAppOptions<H = AppHost> {
  readonly scenario?: ScenarioName<H>
  /** How long `do` and `precondition` may take in real time. */
  readonly timeoutMs?: number
}

export interface TestApp<H = AppHost> extends JourneyClient<DefinitionsOf<H>>, AsyncDisposable {
  readonly raw: RawTestApp
  /** The most recent events, in order, up to a limit on their size. */
  readonly events: ReadonlyArray<RuntimeEvent>
  /** Crashes since the last call, including those of work nobody dispatched. */
  takeDefects(): ReadonlyArray<string>
  readonly client: Client
  inspect(): Promise<InspectResult>
  /** Snapshot of a node by name, including fixtures. */
  inspectRaw(name: string): Promise<NodeSnapshot>
  waitFor(params: WaitParams): Promise<void>
  advanceTime(durationMs: number): Promise<void>
  reset(scenario?: ScenarioName<H>): Promise<void>
  dispose(): Promise<void>
}

export interface RawTestApp {
  /** State of the focused node as of the last call. */
  readonly state: unknown
  readonly client: Client
  request(method: string, params: unknown): Promise<unknown>
  readonly events: ReadonlyArray<RuntimeEvent>
  /** Assert where the journey is before continuing. */
  precondition(screen: string, match?: Json): Promise<void>
  /** Dispatch and wait for the effect and anything it started to settle. */
  dispatchRaw(action: string, input?: Json): Promise<OperationInfo>
  /** Dispatch without waiting, for work that needs time to be advanced. */
  start(action: string, input?: Json): Promise<OperationInfo>
}

/** Runs a journey through the real protocol, serialized as a remote peer would. */
export const createTestApp = async <H extends AppHost>(
  host: H,
  options: TestAppOptions<NoInfer<H>> = {},
): Promise<TestApp<H>> => {
  const { scenario } = options
  const app = await createTestAppOn(
    () => createController(host, scenario === undefined ? {} : { scenario }),
    options,
  )
  if ("nodes" in host && typeof host.nodes === "object" && host.nodes !== null) {
    const definitions = Object.values(host.nodes) as ConsumerDefinition[]
    ;(app as Journey).validateDefinition = (definition) => {
      if (
        !definitions.some((member) => definitionIdentity(member) === definitionIdentity(definition))
      ) {
        throw new Error(`Node "${definition.name}" is not a contract in app "${host.name}"`)
      }
    }
  }
  return app as TestApp<H>
}

/**
 * The same, against a controller from anywhere: a bridge to an app on a device, say.
 * The journey owns it from here, and closes it with the journey. `scenario` does not
 * apply; reset the app to choose one.
 */
export const createTestAppOn = async (
  open: () => Promise<Controller>,
  options: Omit<TestAppOptions, "scenario"> = {},
): Promise<TestApp> => {
  const releaseNetwork = networkGuard.acquire()
  try {
    const controller = await open()
    const app = new Journey(
      () => controller.close(),
      options.timeoutMs ?? JOURNEY_STEP_TIMEOUT_MS_DEFAULT,
      {
        release: releaseNetwork,
      },
      createLoopbackClient(controller),
    )
    await app.begin()
    return app
  } catch (error: unknown) {
    releaseNetwork()
    throw error
  }
}

/**
 * Opens test apps and disposes them together, so that a failed assertion cannot
 * skip the cleanup. Pass `disposeAll` to `afterEach`.
 */
export const createTestAppPool = () => {
  const apps: Array<TestApp> = []
  return {
    open: async <H extends AppHost>(
      host: H,
      options?: TestAppOptions<NoInfer<H>>,
    ): Promise<TestApp<H>> => {
      const app = await createTestApp(host, options)
      apps.push(app)
      return app
    },
    openOn: async (
      open: () => Promise<Controller>,
      options?: Omit<TestAppOptions, "scenario">,
    ): Promise<TestApp> => {
      const app = await createTestAppOn(open, options)
      apps.push(app)
      return app
    },
    disposeAll: async (): Promise<void> => {
      // One at a time, and all of them: a failure must not leave the others running.
      const failures: Array<unknown> = []
      for (const app of apps.splice(0)) {
        await app.dispose().catch((error: unknown) => failures.push(error))
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Some test apps failed to dispose")
      }
    },
  }
}

/** For conditions a test can observe but not subscribe to. */
export const waitUntil = async (condition: () => boolean, description: string): Promise<void> => {
  const deadlineUnixMs = Date.now() + CONDITION_TIMEOUT_MS
  while (!condition()) {
    if (Date.now() > deadlineUnixMs) {
      throw new Error(`Timed out waiting until ${description}`)
    }
    await new Promise((resolve) => setTimeout(resolve, CONDITION_POLL_MS))
  }
}

/** Lets everything already queued run, without guessing at a duration. */
export const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * Behavior tests may not call `fetch`, even by accident. Fixture layers never do, so any
 * call is a leak out of the headless boundary. Other network APIs are not covered. Test
 * apps can overlap, so the guard is counted: it lifts with the last of them.
 */
const networkGuard = (() => {
  let holderCount = 0
  let unguardedFetch: typeof fetch | undefined
  return {
    acquire(): () => void {
      if (holderCount === 0) {
        unguardedFetch = globalThis.fetch
        globalThis.fetch = refuseNetwork
      }
      holderCount++
      let released = false
      return () => {
        if (!released) {
          released = true
          holderCount--
          if (holderCount === 0) {
            globalThis.fetch = defined(unguardedFetch, "it was saved by the first holder")
          }
        }
      }
    },
  }
})()

const refuseNetwork = ((input: unknown) => {
  throw new Error(`Unexpected network request in a behavior test: ${String(input)}`)
  // The guard only ever throws, so its parameters are all it needs of `fetch`.
}) as unknown as typeof fetch

class Journey implements TestApp {
  readonly client: Client
  readonly node: JourneyClient["node"]
  readonly focused: JourneyClient["focused"]
  readonly back: JourneyClient["back"]
  readonly raw: RawTestApp = this
  validateDefinition: (definition: ConsumerDefinition) => void = () => {}
  readonly events: Array<RuntimeEvent> = []
  state: unknown
  private defects: Array<string> = []
  private observedCharacterCount = 0
  private disposed = false

  constructor(
    private readonly close: () => Promise<void>,
    private readonly timeoutMs: number,
    private readonly network: { readonly release: () => void },
    client: Client,
    eventsAvailable = true,
  ) {
    this.client = client
    const journey = createJourneyClient({
      timeoutMs,
      start: (nodeId, action, input) =>
        this.client.request("app.dispatch", {
          nodeId,
          action,
          ...(input === undefined ? {} : { input }),
        }),
      complete: async (operationId) => {
        const { operation } = await this.client.request("app.wait", { operationId, timeoutMs })
        await this.settle()
        await this.inspect()
        return defined(operation, "waiting returns the operation")
      },
      cancel: async (operationId) => {
        await this.client.request("app.cancel", { operationId })
      },
      validateDefinition: (definition) => this.validateDefinition(definition),
      ...(eventsAvailable
        ? { subscribe: (listener: () => void) => this.client.onEvent(listener) }
        : {}),
      inspect: async (name, nodeId) =>
        nodeId !== undefined
          ? defined(
              (await this.client.request("app.inspect", { nodeId })).node ?? undefined,
              "The journey node is still mounted",
            )
          : name === undefined
            ? defined((await this.inspect()).node ?? undefined, "A focused journey has a node")
            : this.inspectRaw(name),
      wait: (name, match) => this.precondition(name, match),
      dispatch: async (nodeId, action, input) => {
        const { operationId } = await this.client.request("app.dispatch", {
          nodeId,
          action,
          ...(input === undefined ? {} : { input }),
        })
        const { operation } = await this.client.request("app.wait", {
          operationId,
          timeoutMs: this.timeoutMs,
        })
        await this.settle()
        await this.inspect()
        return defined(operation, "waiting returns the operation")
      },
    })
    this.node = journey.node
    this.focused = journey.focused
    this.back = journey.back
  }

  /** On failure, nobody else holds this object, so it must clean up after itself. */
  async begin(): Promise<void> {
    this.client.onEvent((event) => this.record(event))
    try {
      const { sessionId } = await this.client.request("app.describe", {})
      await this.client.request("app.subscribe", { since: { sessionId, sequence: 0 } })
      await this.settle()
      await this.inspect()
    } catch (error: unknown) {
      await this.dispose()
      throw error
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    return (this.client.request as (method: string, params: unknown) => Promise<unknown>)(
      method,
      params,
    )
  }

  async inspect(): Promise<InspectResult> {
    const result = await this.client.request("app.inspect", {})
    this.state = result.node?.state
    return result
  }

  async inspectRaw(name: string): Promise<NodeSnapshot> {
    const { node } = await this.client.request("app.inspect", { name })
    return defined(node ?? undefined, "inspecting by name finds the node or fails")
  }

  async precondition(screen: string, match?: Json): Promise<void> {
    const { timeoutMs } = this
    try {
      await this.client.request("app.wait", {
        focus: screen,
        timeoutMs,
        ...(match === undefined ? {} : { match }),
      })
    } catch (error) {
      if (error instanceof ProtocolError && error.code === ErrorCode.WaitTimeout) {
        const last = await this.inspect()
        throw new ProtocolError(
          error.code,
          `${error.message}; last state: ${JSON.stringify(last.node?.state)}`,
          error.data,
        )
      }
      throw error
    }
    await this.inspect()
  }

  async dispatchRaw(action: string, input?: Json): Promise<OperationInfo> {
    const { operationId } = await this.dispatch(action, input)
    const { timeoutMs } = this
    const { operation } = await this.client.request("app.wait", { operationId, timeoutMs })
    await this.settle()
    await this.inspect()
    return defined(operation, "a wait on an operation returns it")
  }

  async start(action: string, input?: Json): Promise<OperationInfo> {
    const operation = await this.dispatch(action, input)
    await this.inspect()
    return operation
  }

  async waitFor(params: WaitParams): Promise<void> {
    await this.client.request("app.wait", { timeoutMs: this.timeoutMs, ...params })
    await this.inspect()
  }

  async advanceTime(durationMs: number): Promise<void> {
    await this.client.request("app.advanceTime", { durationMs })
    await this.inspect()
  }

  async reset(scenario?: string): Promise<void> {
    await this.client.request("app.reset", scenario === undefined ? {} : { scenario })
    await this.settle()
    await this.inspect()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose()
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.client.close()
    try {
      await this.close()
    } finally {
      this.network.release()
    }
  }

  private dispatch(action: string, input: Json | undefined): Promise<OperationInfo> {
    return this.client.request("app.dispatch", {
      action,
      ...(input === undefined ? {} : { input }),
    })
  }

  private async settle(): Promise<void> {
    await this.client.request("app.wait", { idle: true, timeoutMs: this.timeoutMs })
  }

  takeDefects(): ReadonlyArray<string> {
    const defects = this.defects
    this.defects = []
    return defects
  }

  private record(event: RuntimeEvent): void {
    this.events.push(event)
    if (event.type === "operation.finished" && event.operation.status === "failed") {
      const { action, error } = event.operation
      if (error.defect && this.defects.length < OBSERVED_EVENTS_MAX) {
        this.defects.push(`${action} crashed: ${error.message}`)
      }
    }
    this.observedCharacterCount += JSON.stringify(event).length
    if (this.observedCharacterCount > OBSERVED_EVENT_CHARACTERS_MAX) {
      // Half at a time, as this has to render what is left to know its size.
      this.events.splice(0, Math.ceil(this.events.length / 2))
      this.observedCharacterCount = JSON.stringify(this.events).length
    }
  }
}

/** Internal bridge entry: remote services must retain access to the network. */
export const createRemoteTestApp = async (
  client: Client,
  timeoutMs = JOURNEY_STEP_TIMEOUT_MS_DEFAULT,
  eventsAvailable = true,
  close: () => Promise<void> = async () => client.close(),
): Promise<TestApp> => {
  const app = new Journey(close, timeoutMs, { release: () => {} }, client, eventsAvailable)
  await app.begin()
  return app
}
