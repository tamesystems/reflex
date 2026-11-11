import { durationMillis } from "./duration.ts"
import type { DurationInput } from "./duration.ts"
import { connectTarget } from "@reflex/rpc"
import {
  APP_HOST_ADAPTER,
  definitionIdentity,
  descriptorFingerprint,
  type AppHost,
  type ConsumerDefinition,
} from "@reflex/runtime/internal"
import {
  createTestApp as createLegacyTestApp,
  createRemoteTestApp,
  type TestApp,
  type TestAppOptions,
} from "./test-app.ts"
import type { JourneyApp, JourneyClientFor, Scenarios, DefaultScenario } from "./app-types.ts"

export type AnySession = TestApp<{ readonly nodes: Record<string, ConsumerDefinition> }>
export type AuthorApp = JourneyApp & {
  readonly services: unknown
}
export function createTestApp<A extends AuthorApp, K extends Scenarios<A> = DefaultScenario<A>>(
  app: A,
  options?: { readonly scenario?: K; readonly timeoutMs?: number },
): Promise<JourneyClientFor<A, K>>
export async function createTestApp(
  app: AuthorApp,
  options: { readonly scenario?: string; readonly timeoutMs?: number } = {},
): Promise<unknown> {
  const host =
    APP_HOST_ADAPTER in app ? (app[APP_HOST_ADAPTER] as AppHost) : (app as unknown as AppHost)
  const session = await createLegacyTestApp(host, options)
  return bindAppJourney(
    app,
    session as unknown as AnySession,
    options.scenario ?? app.defaultScenario,
  )
}
const definitions = (value: unknown): ConsumerDefinition[] =>
  value == null
    ? []
    : Array.isArray(value)
      ? value
      : typeof value === "object" && "name" in value
        ? [value as ConsumerDefinition]
        : Object.values(value as Record<string, ConsumerDefinition>)
const generations = new WeakMap<object, object>()
/** Bind contracts once; every request still crosses the real protocol. */
export const bindAppJourney = (
  app: AuthorApp,
  session: TestApp<{ readonly nodes: Record<string, ConsumerDefinition> }>,
  scenario: string,
): unknown => {
  const generation = {}
  generations.set(session, generation)
  const requireCurrent = () => {
    if (generations.get(session) !== generation) {
      throw new Error("This journey client was reset; use the client returned by reset()")
    }
  }
  const screens = definitions(app.screens)
  const services = definitions(app.services)
  const fixtures = definitions(
    (app.scenarios as Record<string, { fixtures?: unknown }>)[scenario]?.fixtures,
  )
  const member = (allowed: ConsumerDefinition[], contract: { name: string }) => {
    requireCurrent()
    const found = allowed.find(
      (d) =>
        d === contract ||
        d["~reflex"].contract === contract ||
        definitionIdentity(d) === definitionIdentity(contract),
    )
    if (!found) {
      throw new Error(`${contract.name} does not belong to app ${app.name}, scenario ${scenario}`)
    }
    return found
  }
  return {
    scenario,
    raw: session.raw,
    focused: async (contract: { name: string }, match?: unknown) =>
      session.focused(member(screens, contract), match),
    node: async (definition: ConsumerDefinition) =>
      session.node(member([...services, ...fixtures], definition)),
    service: async (definition: ConsumerDefinition) => session.node(member(services, definition)),
    fixture: async (definition: ConsumerDefinition) => session.node(member(fixtures, definition)),
    open: async (contract: { name: string }, params: import("@reflex/protocol").Json = {}) => {
      const definition = member(screens, contract)
      const encode = definition["~reflex"].encodeParams
      const encoded = encode === undefined ? params : encode(params)
      const snapshot = await session.client.request("app.open", {
        name: definition.name,
        params: encoded,
      })
      await session.waitFor({ focus: definition.name })
      return session.focused(definition).then((node) => {
        if (node.id !== snapshot.id) {
          throw new Error(`Focus changed while opening ${definition.name}`)
        }
        return node
      })
    },
    advanceTime: async (duration: DurationInput) => {
      requireCurrent()
      return session.advanceTime(durationMillis(duration))
    },
    back: async () => {
      requireCurrent()
      await session.back()
    },
    reset: async (next: string) => {
      requireCurrent()
      await session.reset(next)
      return bindAppJourney(app, session, next)
    },
    dispose: () => session.dispose(),
    [Symbol.asyncDispose]: () => session.dispose(),
  }
}
export const createTestAppPool = () => {
  const sessions: { dispose(): Promise<void> }[] = []
  return {
    open: (async (app: AuthorApp, options?: TestAppOptions) => {
      const session = await createTestApp(app as AuthorApp, options)
      sessions.push(session)
      return session
    }) as typeof createTestApp,
    async disposeAll() {
      const results = await Promise.allSettled([...sessions.splice(0).map((s) => s.dispose())])
      const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []))
      if (errors.length) {
        throw new AggregateError(errors, "Some test apps failed to dispose")
      }
    },
  }
}

/** Connect to the very same local target endpoint used by reflex --target. */
export async function connectJourney<
  A extends AuthorApp,
  K extends Scenarios<A> = DefaultScenario<A>,
>(
  app: A,
  options: {
    readonly target: "headless" | "device"
    readonly scenario?: K
    readonly timeoutMs?: number
  },
): Promise<JourneyClientFor<A, K>> {
  const client = await connectTarget(options.target)
  try {
    const description = await client.request("app.describe", {})
    if (description.app !== app.name) {
      throw new Error(`Expected app ${app.name}, found ${description.app}`)
    }
    const expectedFingerprint = descriptorFingerprint(
      app.name,
      definitions(app.screens),
      definitions(app.services),
    )
    if (description.descriptorFingerprint !== expectedFingerprint) {
      throw new Error(
        `App descriptor mismatch for ${app.name}: expected ${expectedFingerprint}, received ${description.descriptorFingerprint ?? "none"}`,
      )
    }
    const scenario = options.scenario ?? app.defaultScenario
    if (description.scenario !== scenario) {
      await client.request("app.reset", { scenario })
    }
    const session = await createRemoteTestApp(client, options.timeoutMs)
    return bindAppJourney(app, session as unknown as AnySession, scenario) as JourneyClientFor<A, K>
  } catch (error) {
    client.close()
    throw error
  }
}
