import { afterAction } from "./action-navigation.ts"
import { SCREEN_CONTRACT, contractIdentity } from "./screen-identity.ts"
import {
  assert,
  defined,
  type Json,
  NAVIGATION_STACK_DEPTH_MAX,
  UNFINISHED_SCREEN_WORK_MAX,
} from "@reflex/protocol"
import type { Runtime } from "@reflex/runtime/internal"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberSet from "effect/FiberSet"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import {
  defineCapability,
  type Capability,
  type OwnedLiveNode,
  mountWithAccess,
  Registry,
  secretFreeEncoder,
  type StateAccess,
  type WireCodec,
} from "./capability.ts"
import type { Erased } from "./erased.ts"
import { isLimitReached } from "./failures.ts"

/** The stack's lock is held meanwhile, so a screen cannot be allowed to take forever. */
const SCREEN_BUILD_TIMEOUT = "30 seconds"
const SCREEN_TEARDOWN_TIMEOUT = "10 seconds"

/** A named requirement, independent of the screen implementation graph. */
export interface NavigatorRequirement<Key extends string> {
  readonly "~reflex/navigator": Key
}
type InitialRoute<Routes extends RouteSchemas> = {
  readonly [K in keyof Routes & string]:
    | { readonly route: K; readonly params: ParamsOf<Routes, K> }
    | (Record<string, never> extends ParamsOf<Routes, K> ? K : never)
}[keyof Routes & string]

type RouteSchemas = { readonly [route: string]: WireCodec<Erased> }

type ParamsOf<Routes extends RouteSchemas, K extends keyof Routes> = Schema.Schema.Type<Routes[K]>

/** All the navigator needs of a screen, whatever its state and actions are. */
type ScreenNode = Pick<OwnedLiveNode<unknown, never>, "id" | "dispose">

type ScreenFactory<Params, R> = (params: Params) => Effect.Effect<ScreenNode, never, R>

/**
 * Params for a route that takes none. `Schema.Struct({})` would accept any
 * non-null value, which a deep link could then put on the stack.
 */
export const NoParams = Schema.Record(Schema.String, Schema.Never)

/** The stack can take no more: in depth, in the size of its state, or in unfinished cleanup. */
export class NavigationStackFull extends Schema.TaggedError<NavigationStackFull>()(
  "NavigationStackFull",
  { message: Schema.String },
) {}

/** A screen took longer to build than a stack can wait, holding its lock. */
export class ScreenBuildTimedOut extends Schema.TaggedError<ScreenBuildTimedOut>()(
  "ScreenBuildTimedOut",
  { message: Schema.String },
) {}

export const NavigationRefused = Schema.Union([NavigationStackFull, ScreenBuildTimedOut])
export type NavigationRefused = NavigationStackFull | ScreenBuildTimedOut

/** Each route's params can be valid and still add up to more than state may hold. */
const refuseOversizedStack = <E>(
  cause: Cause.Cause<E>,
): Effect.Effect<never, E | NavigationStackFull> => {
  const defects = cause.reasons.filter(Cause.isDieReason).map(({ defect }) => defect)
  const first = defects[0]
  // A cleanup crash beside a limit matters more than the expected refusal.
  if (first !== undefined && defects.every(isLimitReached)) {
    assert(isLimitReached(first), "every defect was checked to be a limit")
    return Effect.fail(new NavigationStackFull({ message: first.message }))
  }
  return Effect.failCause(cause)
}

export interface Navigator<Routes extends RouteSchemas> {
  /**
   * Operations run on the navigator's own fiber, never the caller's. A handler
   * that pops its own screen would otherwise close the scope that owns it and
   * wait on itself forever. Instead `back` interrupts that handler, so treat it
   * like `return`: its operation reports `cancelled` even if its work is done.
   * Cancelling a `push` abandons it, leaving the stack and focus untouched.
   */
  push<K extends keyof Routes & string>(
    route: K,
    params: ParamsOf<Routes, K>,
  ): Effect.Effect<void, NavigationRefused>
  readonly back: Effect.Effect<void>
}

/** The navigation service requirement is independent of the screen contract graph. */
export class NavigationService extends Context.Service<
  NavigationService,
  {
    readonly push: (route: string, params: unknown) => Effect.Effect<void, NavigationRefused>
    readonly back: Effect.Effect<void>
  }
>()("@reflex/effect/Navigation") {}

const NavigationState = Schema.Struct({
  stack: Schema.Array(
    Schema.Struct({
      route: Schema.String,
      params: Schema.Json,
      nodeId: Schema.String,
    }),
  ),
})
type NavigationState = typeof NavigationState.Type
type RouteView = NavigationState["stack"][number]

interface RouteEntry {
  readonly scope: Scope.Closeable
  readonly screen: ScreenNode
  readonly view: RouteView
}

type CancelPolicy = "abandon" | "finish"

/**
 * A headless navigator that owns the route stack. Any UI router is a projection
 * of the `Navigation` node's state, never a second source of truth.
 *
 * Each route instance owns a scope, so leaving a screen cancels its work.
 */
const defineSchemaNavigation = <const Routes extends RouteSchemas>(key: string, routes: Routes) => {
  const Tag = Context.Service<Navigator<Routes>>(key)

  const layer = <R>(options: {
    readonly initial: {
      readonly [K in keyof Routes]: { route: K; params: ParamsOf<Routes, K> }
    }[keyof Routes]
    readonly screens: { readonly [K in keyof Routes]: ScreenFactory<ParamsOf<Routes, K>, R> }
  }): Layer.Layer<
    Navigator<Routes> | NavigationService,
    never,
    Exclude<R, Navigator<Routes> | NavigationService | Scope.Scope> | Registry
  > =>
    // Screens may require the navigator being built here, which `provideService`
    // below satisfies. The compiler cannot see that through a generic `R`.
    Layer.effect(
      NavigationService,
      Effect.map(Tag, (nav) => ({
        push: (route, params) => nav.push(route, params as ParamsOf<Routes, keyof Routes>),
        back: nav.back,
      })),
    ).pipe(Layer.provideMerge(Layer.effect(Tag, buildNavigator(Tag, routes, options)))) as never

  return {
    Tag,
    routes,
    layer,
    push: <K extends keyof Routes & string>(
      route: K,
      ...args: Record<string, never> extends ParamsOf<Routes, K>
        ? [params?: ParamsOf<Routes, K>]
        : [params: ParamsOf<Routes, K>]
    ): Effect.Effect<void, NavigationRefused, NavigationService> =>
      Effect.flatMap(NavigationService, (nav) =>
        nav.push(route, (args[0] ?? {}) as ParamsOf<Routes, K>),
      ),
    back: Effect.flatMap(NavigationService, (nav) => nav.back),
  }
}

type ScreenDefinitions = Record<
  string,
  Capability<Erased, Erased, Erased, Erased, Erased> & {
    readonly initial: (params: Erased) => Erased
  }
>
type ScreenRequirements<D extends ScreenDefinitions> =
  D[keyof D] extends Capability<Erased, Erased, infer R, Erased, Erased> ? R : never
export const defineNavigationFactories = defineSchemaNavigation

/** Contract-first navigation: implementations are supplied only when composing the app. */
type ScreenContracts = Record<
  string,
  {
    readonly implement: (...args: never[]) => unknown
    readonly [SCREEN_CONTRACT]: { readonly key: symbol | string }
    readonly name: string
    readonly state: WireCodec<Erased>
    readonly params?: WireCodec<Erased>
    readonly initial: (params: Erased) => Erased
  }
>

const validateImplementations = (
  key: string,
  contracts: ScreenContracts,
  screens: ScreenDefinitions,
): void => {
  const identities = new Set<object>()
  for (const [name, contract] of Object.entries(contracts)) {
    const screen = screens[name]
    if (screen === undefined || contractIdentity(screen) !== contractIdentity(contract)) {
      throw new Error(`Navigator "${key}" screen "${name}" must implement its registered contract`)
    }
    if (identities.has(contractIdentity(screen))) {
      throw new Error(
        `Navigator "${key}" has duplicate implementations of contract "${contract.name}"`,
      )
    }
    identities.add(contractIdentity(screen))
  }
}

const assertContracts = (key: string, contracts: ScreenContracts): void => {
  for (const [name, contract] of Object.entries(contracts)) {
    if (typeof contract.implement !== "function") {
      throw new Error(
        `Navigator "${key}" slot "${name}" must use a defineScreen contract, not a capability implementation`,
      )
    }
  }
}

const defineContractNavigation = <const Key extends string, const D extends ScreenContracts>(
  key: Key,
  contracts: D,
) => {
  assertContracts(key, contracts)
  type Routes = {
    readonly [K in keyof D]: D[K] extends { readonly params: infer P extends WireCodec<Erased> }
      ? P
      : typeof NoParams
  }
  const routes = Object.fromEntries(
    Object.entries(contracts).map(([name, screen]) => [name, screen.params ?? NoParams]),
  ) as Routes
  const navigation = defineSchemaNavigation(key, routes)
  // A literal service key is a type-level identity, as well as the runtime lookup key.
  type Service = NavigatorRequirement<Key>
  const Service = Context.Service<Service, Navigator<Routes>>(key)
  type Args = {
    [K in keyof Routes & string]: keyof ParamsOf<Routes, K> extends never
      ? [route: K]
      : string extends keyof ParamsOf<Routes, K>
        ? [route: K] | [route: K, params: ParamsOf<Routes, K>]
        : [route: K, params: ParamsOf<Routes, K>]
  }[keyof Routes & string]
  return {
    screens: contracts,
    key,
    push: (...[route, params]: Args): Effect.Effect<void, NavigationRefused, Service> =>
      Effect.flatMap(Service, (nav) =>
        afterAction(nav.push(route, params ?? ({} as ParamsOf<Routes, keyof Routes>))),
      ),
    back: Effect.flatMap(Service, (nav) => afterAction(nav.back)),
    layer: <
      const Screens extends {
        readonly [K in keyof D]: Capability<
          Schema.Schema.Type<D[K]["state"]>,
          Erased,
          Erased,
          Schema.Schema.Type<Routes[K]>,
          D[K]["state"]["Encoded"]
        > & {
          readonly name: D[K]["name"]
          readonly [SCREEN_CONTRACT]: D[K][typeof SCREEN_CONTRACT]
          readonly initial: (params: Erased) => Erased
        }
      },
    >(options: {
      readonly initial: InitialRoute<Routes>
      readonly screens: Screens
    }) => {
      const screens = options.screens
      validateImplementations(key, contracts, screens)
      const factories = Object.fromEntries(
        Object.entries(screens).map(([name, screen]) => [
          name,
          (params: unknown) =>
            Effect.map(mountWithAccess(screen, screen.initial(params)), ({ node }) => node),
        ]),
      ) as unknown as {
        readonly [K in keyof Routes]: ScreenFactory<
          ParamsOf<Routes, K>,
          ScreenRequirements<Screens>
        >
      }
      return Object.assign(
        navigation.layer({
          initial: (typeof options.initial === "string"
            ? { route: options.initial, params: {} }
            : options.initial) as {
            readonly [K in keyof Routes]: { route: K; params: ParamsOf<Routes, K> }
          }[keyof Routes],
          screens: factories,
        }),
        {
          nodes: screens,
          navigatorKeys: [key],
          contracts,
        },
      ) as unknown as Layer.Layer<
        Service,
        never,
        Exclude<ScreenRequirements<Screens>, Service | Scope.Scope> | Registry
      > & { readonly nodes: Screens; readonly contracts: D; readonly navigatorKeys: readonly Key[] }
    },
  }
}

const navigatorKeys = new WeakMap<Runtime, Set<string>>()

const buildNavigator = <Routes extends RouteSchemas>(
  Tag: Context.Service<Navigator<Routes>, Navigator<Routes>>,
  routes: Routes,
  options: {
    readonly initial: { readonly route: keyof Routes; readonly params: unknown }
    readonly screens: { readonly [K in keyof Routes]: ScreenFactory<Erased, Erased> }
  },
) =>
  Effect.gen(function* () {
    const registry = yield* Registry
    const keys = navigatorKeys.get(registry) ?? new Set<string>()
    if (keys.has(Tag.key)) {
      throw new Error(`Duplicate navigator key "${Tag.key}" in this app; use unique keys`)
    }
    keys.add(Tag.key)
    navigatorKeys.set(registry, keys)
    const context = yield* Effect.context<never>()
    const fibers = yield* FiberSet.make<unknown, unknown>()
    const stack = new RouteStack<Routes>({
      registry,
      routes,
      screens: options.screens,
      parentScope: yield* Effect.scope,
      runDetached: (work) => {
        const fiber = Effect.runForkWith(context)(work)
        FiberSet.addUnsafe(fibers, fiber)
        return fiber
      },
      // `context` above holds everything else a screen requires, and the fiber that
      // runs this is forked with it, so the navigator is the last requirement.
      provide: (effect, navigator) =>
        Effect.provideService(effect, Tag, navigator).pipe(
          Effect.provideService(NavigationService, {
            push: (route, params) =>
              navigator.push(route, params as ParamsOf<Routes, keyof Routes>),
            back: navigator.back,
          }),
        ) as Effect.Effect<ScreenNode>,
    })
    const Navigation = navigationCapability(routes, stack)
    const { access } = yield* mountWithAccess(Navigation, { stack: [] })
    stack.publishTo(access)
    const { route, params } = options.initial
    yield* stack.pushRoute(String(route), params).pipe(Effect.orDie)
    return stack
  })

const navigationCapability = <Routes extends RouteSchemas>(
  routes: Routes,
  navigator: RouteStack<Routes>,
) => {
  const members = Object.entries(routes).map(([route, params]) =>
    Schema.Struct({ route: Schema.Literal(route), params }),
  )
  // A union built at runtime, whose members all have this shape.
  const NavigateInput = Schema.Union(members) as unknown as WireCodec<{
    readonly route: string
    readonly params: unknown
  }>
  return defineCapability({
    name: "Navigation",
    type: "navigation",
    state: NavigationState,
    actions: (action) => ({
      GoBack: action({
        description: "Return to the previous screen",
        available: ({ stack }) => (stack.length > 1 ? true : "Already at the root screen"),
        handler: () => navigator.back,
      }),
      Navigate: action({
        description: "Open a route directly, as a deep link would",
        input: NavigateInput,
        error: NavigationRefused,
        available: ({ stack }) =>
          stack.length < NAVIGATION_STACK_DEPTH_MAX ? true : "The route stack is full",
        handler: ({ route, params }) => navigator.pushRoute(route, params),
      }),
    }),
  })
}

interface RouteStackOptions<Routes extends RouteSchemas> {
  readonly registry: Runtime
  readonly routes: Routes
  readonly screens: { readonly [K in keyof Routes]: ScreenFactory<Erased, Erased> }
  readonly parentScope: Scope.Scope
  readonly runDetached: <A, E>(work: Effect.Effect<A, E>) => Fiber.Fiber<A, E>
  readonly provide: (
    effect: Effect.Effect<ScreenNode, never, Erased>,
    navigator: Navigator<Routes>,
  ) => Effect.Effect<ScreenNode>
}

/** `entries` is the only record of the stack; the node's state is derived from it. */
class RouteStack<Routes extends RouteSchemas> implements Navigator<Routes> {
  private entries: ReadonlyArray<RouteEntry> = []
  private readonly lock = Semaphore.makeUnsafe(1)
  private access: StateAccess<NavigationState> | undefined
  private unfinishedScreenWorkCount = 0
  private readonly encoders: ReadonlyMap<string, (params: unknown) => Json>

  constructor(private readonly options: RouteStackOptions<Routes>) {
    this.encoders = new Map(
      Object.entries(options.routes).map(([route, schema]) => [route, secretFreeEncoder(schema)]),
    )
  }

  /** The node's actions need this stack, so the node can only be mounted after it. */
  publishTo(access: StateAccess<NavigationState>): void {
    this.access = access
  }

  push<K extends keyof Routes & string>(
    route: K,
    params: ParamsOf<Routes, K>,
  ): Effect.Effect<void, NavigationRefused> {
    return this.pushRoute(route, params)
  }

  /** For callers that have checked `params` against `route` by other means. */
  pushRoute(route: string, params: unknown): Effect.Effect<void, NavigationRefused> {
    return this.onOwnFiber(this.enter(route, params), "abandon")
  }

  get back(): Effect.Effect<void> {
    return this.onOwnFiber(this.leave(), "finish")
  }

  private onOwnFiber<A, E>(work: Effect.Effect<A, E>, onCancel: CancelPolicy): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      const fiber = this.options.runDetached(this.lock.withPermits(1)(work))
      if (onCancel === "abandon") {
        return Effect.onInterrupt(Fiber.join(fiber), () => Fiber.interrupt(fiber))
      }
      return Fiber.join(fiber)
    })
  }

  /** Only building the screen can be cancelled; committing it cannot. */
  private enter(route: string, params: unknown): Effect.Effect<void, NavigationRefused> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        if (this.entries.length >= NAVIGATION_STACK_DEPTH_MAX) {
          const message = `The route stack is at ${NAVIGATION_STACK_DEPTH_MAX}`
          return yield* new NavigationStackFull({ message })
        }
        if (this.unfinishedScreenWorkCount >= UNFINISHED_SCREEN_WORK_MAX) {
          const message = "Too many screens are still being built or cleaned up"
          return yield* new NavigationStackFull({ message })
        }
        const encode = defined(this.encoders.get(route), "route names are typed")
        const encodedParams = yield* Effect.sync(() => encode(params)).pipe(
          Effect.catchCause(refuseOversizedStack),
        )
        const scope = yield* Scope.fork(this.options.parentScope)
        const screen = yield* restore(this.build(route, params, scope)).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : this.closeScreen(scope, exit),
          ),
          Effect.catchCause(refuseOversizedStack),
        )
        const view = { route, params: encodedParams, nodeId: screen.id }
        yield* this.commit([...this.entries, { scope, screen, view }]).pipe(
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) {
              return Effect.void
            }
            screen.dispose()
            return this.closeScreen(scope, exit)
          }),
          Effect.catchCause(refuseOversizedStack),
        )
        this.focusTop()
      }),
    )
  }

  /**
   * The stack's lock is held while building, so a screen that navigates as it is
   * built would wait for itself. It gets a navigator that says so instead, for as
   * long as that is true. Its handlers keep the same navigator, so it must recover.
   */
  private build(
    route: string,
    params: unknown,
    scope: Scope.Closeable,
  ): Effect.Effect<ScreenNode, ScreenBuildTimedOut> {
    const factory = defined(this.options.screens[route], "every route has a screen")
    let building = true
    const refuseWhileBuilding = <A, E>(work: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.suspend(() => {
        if (building) {
          return Effect.die(new Error(`Screen "${route}" navigated while being built`))
        }
        return work
      })
    const navigator: Navigator<Routes> = {
      push: (next, nextParams) => refuseWhileBuilding(this.push(next, nextParams)),
      back: refuseWhileBuilding(this.back),
    }
    const work = this.options.provide(factory(params).pipe(Scope.provide(scope)), navigator)
    const finished = Effect.sync(() => {
      building = false
    })
    return this.supervised<ScreenNode, ScreenBuildTimedOut>(work.pipe(Effect.ensuring(finished)), {
      duration: SCREEN_BUILD_TIMEOUT,
      onAbandon: "interrupt",
      overdue: Effect.fail(
        new ScreenBuildTimedOut({ message: `Screen "${route}" took too long to build` }),
      ),
    })
  }

  /**
   * Building or closing a screen runs app code that a deadline cannot stop: acquiring a
   * resource, or a finalizer, cannot be interrupted. So it runs apart, to be left behind,
   * counted until it really ends, and with a failure reported if nobody is left to hear.
   */
  private supervised<A, E>(
    work: Effect.Effect<A, E>,
    deadline: {
      readonly duration: Duration.Input
      readonly onAbandon: "interrupt" | "let-finish"
      readonly overdue: Effect.Effect<A, E>
    },
  ): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      let abandoned = false
      this.unfinishedScreenWorkCount++
      const fiber = this.options.runDetached(
        work.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              this.unfinishedScreenWorkCount--
              assert(this.unfinishedScreenWorkCount >= 0, "screen work is counted once")
              if (abandoned && Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
                this.options.registry.report(Cause.squash(exit.cause))
              }
            }),
          ),
        ),
      )
      // A deadline interrupts this wait too, so both ways of giving up come through here.
      const abandon = Effect.sync(() => {
        abandoned = true
        if (deadline.onAbandon === "interrupt") {
          this.options.runDetached(Fiber.interrupt(fiber))
        }
      })
      return Fiber.join(fiber).pipe(
        Effect.onInterrupt(() => abandon),
        Effect.timeoutOrElse({ duration: deadline.duration, orElse: () => deadline.overdue }),
      )
    })
  }

  private leave(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.entries.length <= 1) {
        return
      }
      const top = defined(this.entries.at(-1), "the stack was just checked to be non-empty")
      yield* this.commit(this.entries.slice(0, -1))
      // Before its cleanup, which is app code: it can fail, or take its time.
      this.focusTop()
      top.screen.dispose()
      yield* this.closeScreen(top.scope, Exit.void)
    })
  }

  /** Every way a screen ends comes through here. */
  private closeScreen(
    scope: Scope.Closeable,
    exit: Exit.Exit<unknown, unknown>,
  ): Effect.Effect<void> {
    return this.supervised(Scope.close(scope, exit), {
      duration: SCREEN_TEARDOWN_TIMEOUT,
      onAbandon: "let-finish",
      overdue: Effect.sync(() => {
        this.options.registry.report(new Error("A screen took too long to clean up"))
      }),
    })
  }

  private commit(entries: ReadonlyArray<RouteEntry>): Effect.Effect<void> {
    return Effect.suspend(() => {
      assert(this.access !== undefined, "the node is mounted before the first push")
      const stack = entries.map(({ view }) => view)
      // After the update, which can refuse a stack: the two must not disagree.
      return this.access
        .update(() => ({ stack }))
        .pipe(
          Effect.andThen(
            Effect.sync(() => {
              this.entries = entries
            }),
          ),
        )
    })
  }

  private focusTop(): void {
    const top = defined(this.entries.at(-1), "the root screen is never popped")
    this.options.registry.setFocus(top.screen.id)
  }
}

export const defineNavigation = <const Key extends string, const D extends ScreenContracts>(
  key: Key,
  contracts: D,
) => {
  const navigation = defineContractNavigation(key, contracts)
  return {
    ...navigation,
    implement: <const Screens extends Parameters<typeof navigation.layer>[0]["screens"]>(
      screens: Screens,
      options: {
        readonly initial: InitialRoute<{
          readonly [K in keyof D]: D[K] extends {
            readonly params: infer P extends WireCodec<Erased>
          }
            ? P
            : typeof NoParams
        }>
      },
    ) => ({
      ...navigation,
      layer: navigation.layer<Screens>({
        screens,
        initial: options.initial as Parameters<typeof navigation.layer>[0]["initial"],
      }),
      nodes: screens,
    }),
  }
}
