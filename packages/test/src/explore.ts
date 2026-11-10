import {
  ErrorCode,
  type InspectResult,
  type Json,
  type NodeId,
  ProtocolError,
} from "@reflex/protocol"
import type { AppHost, ConsumerDefinition, ScenarioName } from "@reflex/runtime/internal"
import type { InferState } from "./journey-client.ts"
import { createTestApp, type TestApp } from "./test-app.ts"

const RUN_COUNT_DEFAULT = 25
const RUN_COUNT_MAX = 1_000
const STEP_COUNT_DEFAULT = 20
const STEP_COUNT_MAX = 1_000
const SEED_DEFAULT = 1
const STEP_TIMEOUT_MS = 2_000
/** Long enough for any sleeper a fixture has, in one virtual jump. */
const VIRTUAL_TIME_STEP_MS = 60_000
const SAMPLE_SEED_MAX = 2 ** 31
/** Each replay is a whole session, so shrinking is given a budget, not a promise. */
const SHRINK_REPLAYS_MAX = 200

const UNREACHABLE_ON_REPLAY: ReadonlySet<number> = new Set([
  ErrorCode.NodeNotFound,
  ErrorCode.ActionNotFound,
  ErrorCode.ActionUnavailable,
])

export interface ExploreStep {
  readonly nodeId: NodeId
  readonly action: string
  readonly input: Json
}

interface NodeInputs {
  readonly node: string
  readonly inputs: Readonly<Record<string, ReadonlyArray<Json>>>
}
interface WalkOptions {
  readonly scenario?: string
  readonly runCount?: number
  readonly stepCount?: number
  readonly seed?: number
  /**
   * Real values for actions whose schema cannot know them, such as an id that
   * must exist. Without these a walk only ever finds the "not found" path.
   */
  readonly knownInputs?: ReadonlyArray<NodeInputs>
  /** Return a message when the app is in a state that must never happen. */
  readonly invariant?: (snapshot: InspectResult) => string | undefined
}

export interface ExploreFailure {
  readonly seed: number
  readonly message: string
  /** The shortest sequence found, within budget, that still reproduces the failure. */
  readonly steps: ReadonlyArray<ExploreStep>
}

export interface ExploreResult {
  readonly runCount: number
  readonly actionsDispatched: number
  readonly actionsCovered: ReadonlyArray<string>
  readonly failure?: ExploreFailure
}

/**
 * Random walk through whatever the app says is available, with inputs generated
 * from each action's schema. Availability comes from the app, so the walk stays
 * on reachable paths without being told what they are.
 */
type HostNodes<H> = H extends { readonly nodes: infer N } ? N : Record<never, never>
export type ExplorationInvariants<H> = {
  readonly [K in keyof HostNodes<H>]?: (state: InferState<HostNodes<H>[K]>) => string | undefined
}
export type ExplorationInputs<H> = {
  readonly [K in keyof HostNodes<H>]?: {
    readonly [A in keyof import("./journey-client.ts").InferActions<
      HostNodes<H>[K]
    >]?: ReadonlyArray<
      import("./journey-client.ts").InferActions<HostNodes<H>[K]>[A] extends (
        ...args: infer Args
      ) => unknown
        ? Args extends [infer I]
          ? I
          : never
        : never
    >
  }
}
export type ExploreOptions<H> = Omit<WalkOptions, "scenario" | "knownInputs"> & {
  readonly scenario?: ScenarioName<H>
  readonly knownInputs?: ExplorationInputs<H>
  readonly invariants?: ExplorationInvariants<H>
}
export const explore = async <H extends AppHost>(
  host: H,
  input: ExploreOptions<NoInfer<H>> = {},
): Promise<ExploreResult> => {
  const options: WalkOptions = {
    ...input,
    knownInputs: Object.entries(input.knownInputs ?? {}).map(([key, inputs]) => {
      const nodes = ("nodes" in host ? host.nodes : {}) as Record<string, ConsumerDefinition>
      const definition = nodes[key]
      if (definition === undefined) {
        throw new Error(`Unknown exploration node "${key}"`)
      }
      return {
        node: definition.name,
        inputs: Object.fromEntries(
          Object.entries(inputs as Record<string, readonly unknown[]>).map(([action, values]) => [
            action,
            values.map((value) => {
              const encoded = definition["~reflex"].input(action, [value])
              return encoded === undefined ? {} : encoded
            }),
          ]),
        ),
      }
    }),
    invariant: (snapshot) => {
      const failure = input.invariant?.(snapshot)
      if (failure !== undefined || snapshot.node === null) {
        return failure
      }
      const nodes = ("nodes" in host ? host.nodes : {}) as Record<string, ConsumerDefinition>
      const entry = Object.entries(nodes).find(
        ([, definition]) => definition.name === snapshot.node?.name,
      )
      if (entry === undefined) {
        return undefined
      }
      const [key, definition] = entry
      const check = (
        input.invariants as Record<string, (state: unknown) => string | undefined> | undefined
      )?.[key]
      return check?.(definition["~reflex"].state(snapshot.node.state))
    },
  }
  const runCount = requireCount("runCount", options.runCount ?? RUN_COUNT_DEFAULT, RUN_COUNT_MAX)
  const stepCount = requireCount(
    "stepCount",
    options.stepCount ?? STEP_COUNT_DEFAULT,
    STEP_COUNT_MAX,
  )
  const firstSeed = requireSeed(options.seed ?? SEED_DEFAULT, runCount)
  const covered = new Set<string>()
  let actionsDispatched = 0

  for (let runIndex = 0; runIndex < runCount; runIndex++) {
    const seed = firstSeed + runIndex
    const { trace, message } = await walk(host, options, { seed, stepCount })
    actionsDispatched += trace.length
    for (const { action } of trace) {
      covered.add(action)
    }
    if (message !== undefined) {
      const steps = await shrink(host, trace, { ...options, failure: message })
      return {
        runCount: runIndex + 1,
        actionsDispatched,
        actionsCovered: [...covered].sort(),
        failure: { seed, message, steps },
      }
    }
  }
  return { runCount, actionsDispatched, actionsCovered: [...covered].sort() }
}

const requireCount = (name: string, value: number, maximum: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`"${name}" must be an integer from 1 to ${maximum}`)
  }
  return value
}

/** Each run's seed is derived by adding to this, which must stay exact. */
const requireSeed = (seed: number, runCount: number): number => {
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(seed + runCount)) {
    throw new Error(`"seed" must be an integer, with room for ${runCount} runs`)
  }
  return seed
}

const appOptions = ({ scenario }: WalkOptions) => (scenario === undefined ? {} : { scenario })

const walk = async (
  host: AppHost,
  options: WalkOptions,
  { seed, stepCount }: { readonly seed: number; readonly stepCount: number },
) => {
  const next = seededRandom(seed)
  const trace: Array<ExploreStep> = []
  const app = await createTestApp(host, appOptions(options))
  try {
    const { capabilities } = await app.client.request("app.describe", {})
    const clock = capabilities.virtualTime ? "virtual" : "real"
    const initial = await initialProblem(app, options)
    if (initial !== undefined) {
      return { trace, message: initial }
    }
    for (let stepIndex = 0; stepIndex < stepCount; stepIndex++) {
      const snapshot = await app.client.request("app.inspect", {})
      const choices = availableActions(snapshot)
      const choice = choices[Math.floor(next() * choices.length)]
      if (choice === undefined) {
        break
      }
      const input = await chooseInput(app, choice, options, next)
      const step = { ...choice, input }
      trace.push(step)
      const message = await perform(app, step, options, { clock, stepsMustApply: true })
      if (message !== undefined) {
        return { trace, message }
      }
    }
    return { trace, message: undefined }
  } finally {
    await app.dispose()
  }
}

const chooseInput = async (
  app: TestApp,
  choice: { readonly nodeId: NodeId; readonly action: string },
  options: WalkOptions,
  next: () => number,
): Promise<Json> => {
  const { node } = await app.client.request("app.inspect", { nodeId: choice.nodeId })
  const known = options.knownInputs?.find((inputs) => inputs.node === node?.name)?.inputs[
    choice.action
  ]
  const knownIndex = Math.floor(next() * (known?.length ?? 0))
  const sampleSeed = Math.floor(next() * SAMPLE_SEED_MAX)
  // `null` is a legitimate known input, so only absence falls back to generating.
  const knownInput = known?.[knownIndex]
  if (knownInput !== undefined) {
    return knownInput
  }
  const { input } = await app.client.request("app.sample", { ...choice, seed: sampleSeed })
  return input
}

/** A failed seed must reproduce, so the walk's choices come from it alone. */
const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32
}

const availableActions = ({ node, ambient }: InspectResult) => {
  const choices: Array<{ readonly nodeId: NodeId; readonly action: string }> = []
  if (node !== null) {
    for (const [action, descriptor] of Object.entries(node.actions)) {
      if (descriptor.available) {
        choices.push({ nodeId: node.id, action })
      }
    }
  }
  for (const { available, nodeId, nodeType, action } of ambient) {
    if (available && nodeType !== "fixture") {
      choices.push({ nodeId, action })
    }
  }
  return choices
}

interface PerformMode {
  readonly clock: "real" | "virtual"
  /** On a replay with steps removed, a later step can stop being reachable. */
  readonly stepsMustApply: boolean
}

/** Run one step. Returns a failure message, or undefined if it held up. */
const perform = async (
  app: TestApp,
  step: ExploreStep,
  options: WalkOptions,
  mode: PerformMode,
): Promise<string | undefined> => {
  const { client } = app
  const dispatched = await client.request("app.dispatch", step).catch((error: unknown) => {
    if (error instanceof ProtocolError) {
      return error
    }
    throw error
  })
  if (dispatched instanceof ProtocolError) {
    return refusalMessage(dispatched, step, mode)
  }
  if (mode.clock === "virtual") {
    await client.request("app.advanceTime", { durationMs: VIRTUAL_TIME_STEP_MS })
  }
  try {
    const { operation } = await client.request("app.wait", {
      operationId: dispatched.operationId,
      timeoutMs: STEP_TIMEOUT_MS,
    })
    await client.request("app.wait", { idle: true, timeoutMs: STEP_TIMEOUT_MS })
    if (operation?.status === "failed" && operation.error.defect) {
      return `${step.action} crashed: ${operation.error.message}`
    }
    // Work the step set off, such as a focus hook, ends in its own operation.
    const [defect] = app.takeDefects()
    if (defect !== undefined) {
      return defect
    }
  } catch (error: unknown) {
    // A step that hangs is a finding, and it needs its seed and steps to be useful.
    if (error instanceof ProtocolError && error.code === ErrorCode.WaitTimeout) {
      return `${step.action} did not finish within ${STEP_TIMEOUT_MS}ms`
    }
    throw error
  }
  return options.invariant?.(await client.request("app.inspect", {}))
}

/** Starting can crash too, in work no step set off, and with no step to blame. */
const initialProblem = async (app: TestApp, options: WalkOptions): Promise<string | undefined> => {
  const [defect] = app.takeDefects()
  return defect ?? options.invariant?.(await app.client.request("app.inspect", {}))
}

const refusalMessage = (error: ProtocolError, step: ExploreStep, mode: PerformMode) => {
  if (error.code === ErrorCode.InvalidInput) {
    const input = JSON.stringify(step.input)
    return `${step.action} rejected an input its own schema generated: ${input}`
  }
  if (!mode.stepsMustApply && UNREACHABLE_ON_REPLAY.has(error.code)) {
    return undefined
  }
  return `${step.action} was refused: ${error.message}`
}

const replay = async (
  host: AppHost,
  steps: ReadonlyArray<ExploreStep>,
  options: WalkOptions,
): Promise<string | undefined> => {
  const app = await createTestApp(host, appOptions(options))
  try {
    const { capabilities } = await app.client.request("app.describe", {})
    const clock = capabilities.virtualTime ? "virtual" : "real"
    const initial = await initialProblem(app, options)
    if (initial !== undefined) {
      return initial
    }
    for (const step of steps) {
      const message = await perform(app, step, options, { clock, stepsMustApply: false })
      if (message !== undefined) {
        return message
      }
    }
    return undefined
  } finally {
    await app.dispose()
  }
}

/**
 * Removes runs of steps, widest first and then one at a time, until nothing more
 * can go. Windows matter: a push and its back can only be removed together.
 */
const shrink = async (
  host: AppHost,
  steps: ReadonlyArray<ExploreStep>,
  options: WalkOptions & { readonly failure: string },
): Promise<ReadonlyArray<ExploreStep>> => {
  let current = steps
  let replayCount = 0
  const stillFails = async (candidate: ReadonlyArray<ExploreStep>) => {
    replayCount++
    return (await replay(host, candidate, options)) === options.failure
  }
  let shrunk = true
  while (shrunk && replayCount < SHRINK_REPLAYS_MAX) {
    shrunk = false
    for (let width = Math.floor(current.length / 2); width >= 1; width = Math.floor(width / 2)) {
      for (let start = current.length - width; start >= 0; start--) {
        if (replayCount >= SHRINK_REPLAYS_MAX) {
          return current
        }
        const candidate = [...current.slice(0, start), ...current.slice(start + width)]
        if (await stillFails(candidate)) {
          current = candidate
          shrunk = true
          start = Math.min(start, current.length - width + 1)
        }
      }
    }
  }
  return current
}
