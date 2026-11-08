/**
 * The controller against a fake router that keeps a real history, reported the
 * way Expo Router reports it, and a clock these tests move by hand. Each test
 * delivers locations explicitly, because their order relative to the core's stack
 * is the thing being tested.
 */
import { expect, test } from "bun:test"
import { defined, type OperationInfo, toNodeId, toOperationId } from "@reflex/protocol"
import { nextTurn } from "@reflex/test"
import type { Destination, RouterLocation, StackEntry } from "../src/projection.ts"
import {
  ProjectionController,
  ROUTER_DEADLINE_LATENESS_MAX_MS,
  type RouterPort,
} from "../src/projection-controller.ts"

const entry = (id: string): StackEntry => ({ route: id, params: {}, nodeId: toNodeId(id) })

const finished = (status: "completed" | "cancelled"): OperationInfo => ({
  operationId: toOperationId("op"),
  nodeId: toNodeId("nav"),
  action: "any",
  status,
})

const at = (route: string, token: string | null = null): RouterLocation => ({
  token,
  destination: { route, params: {} },
})

const [list, detail, settings] = [entry("list"), entry("detail"), entry("settings")]

type Answer = (destination?: Destination) => Promise<OperationInfo>

const fakeRouter = (location: RouterLocation) => {
  const history: Array<RouterLocation> = [location]
  const shown = () => defined(history.at(-1), "the router always shows something")
  const replaceTop = (next: RouterLocation) => {
    history[history.length - 1] = next
  }
  const locationOf = ({ route, nodeId }: StackEntry) => at(route, nodeId)
  const port: RouterPort = {
    push: (target) => history.push(locationOf(target)),
    replace: (target) => replaceTop(locationOf(target)),
    tag: (target) => replaceTop({ ...shown(), token: target.nodeId }),
    back: () => history.pop(),
    shownToken: () => shown().token,
  }
  return { history, shown, port }
}

const setup = (initial: ReadonlyArray<StackEntry>, location: RouterLocation) => {
  const { history, shown, port } = fakeRouter(location)
  const errors: Array<unknown> = []
  /** Each pending callback, and when it is due. */
  const scheduled = new Map<() => void, number>()
  let time = 0
  let stack = initial
  let open = true
  let answer: Answer = async () => finished("completed")

  const controller = new ProjectionController({
    router: port,
    core: {
      isOpen: () => open,
      readStack: () => stack,
      goBack: () => answer(),
      navigate: (destination) => answer(destination),
    },
    initialLocation: location,
    onError: (error) => errors.push(error),
    schedule: (callback, delayMs) => {
      scheduled.set(callback, time + delayMs)
      return () => scheduled.delete(callback)
    },
    now: () => time,
  })

  /** Moves the clock to the last pending deadline plus `lateByMs`, and runs them all. */
  const passDeadlines = (lateByMs: number) => {
    expect(scheduled.size).toBeGreaterThan(0)
    time = Math.max(...scheduled.values()) + lateByMs
    for (const callback of [...scheduled.keys()]) {
      scheduled.delete(callback)
      callback()
    }
  }

  controller.onStack(initial)
  controller.onLocation(location)
  return {
    controller,
    history,
    errors,
    /** Report where the router is now, as its next render would. */
    report: () => controller.onLocation(shown()),
    coreMoves: (next: ReadonlyArray<StackEntry>) => {
      stack = next
      controller.onStack(next)
    },
    /** The user moves the router, without the projection being involved. */
    userPush: (target: RouterLocation) => history.push(target),
    userBack: () => history.pop(),
    setStack: (next: ReadonlyArray<StackEntry>) => {
      stack = next
    },
    answerWith: (next: Answer) => {
      answer = next
    },
    passArrivalTimeout: () => passDeadlines(0),
    /** The deadline fires late, as it does once a blocked JavaScript thread frees up. */
    passArrivalTimeoutAfterStall: () => passDeadlines(ROUTER_DEADLINE_LATENESS_MAX_MS + 1),
    pendingTimerCount: () => scheduled.size,
    endSession: () => {
      open = false
    },
  }
}

test("core pushes reach the router, and arriving there is not an event", () => {
  const { history, report, coreMoves, pendingTimerCount } = setup([list], at("list"))
  coreMoves([list, detail])
  report()
  expect(history).toEqual([at("list"), at("detail", "detail")])
  expect(pendingTimerCount()).toBe(0)
})

test("a repeated location during a push is not read as a return", async () => {
  const { controller, report, coreMoves, answerWith } = setup([list], at("list"))
  let attemptCount = 0
  answerWith(async () => {
    attemptCount++
    return finished("completed")
  })
  coreMoves([list, detail])
  // The router has been told to push, and repeats where it still was.
  controller.onLocation(at("list"))
  report()
  await nextTurn()
  expect(attemptCount).toBe(0)
})

test("repeating both entry points changes nothing, as React may do at any time", () => {
  const { controller, history, report, coreMoves } = setup([list], at("list"))
  coreMoves([list, detail])
  report()
  coreMoves([list, detail])
  report()
  controller.onStack([list, detail])
  expect(history).toHaveLength(2)
})

test("a push the user undoes before it shows reaches the core without waiting", async () => {
  const { controller, coreMoves, setStack, answerWith, userBack, report, pendingTimerCount } =
    setup([list], at("list"))
  const backs: Array<string> = []
  answerWith(async () => {
    backs.push("goBack")
    setStack([list])
    return finished("completed")
  })
  coreMoves([list, detail])
  userBack()
  // One render commits both actions; each is reported with the state it left.
  controller.onLocation(at("detail", "detail"))
  controller.onLocation(at("list"))
  report()
  await nextTurn()
  expect(backs).toEqual(["goBack"])
  expect(pendingTimerCount()).toBe(0)
})

test("a push the router drops without a word is found by the deadline", async () => {
  const { coreMoves, setStack, answerWith, passArrivalTimeout, userBack, report } = setup(
    [list],
    at("list"),
  )
  const backs: Array<string> = []
  answerWith(async () => {
    backs.push("goBack")
    setStack([list])
    return finished("completed")
  })
  coreMoves([list, detail])
  userBack()
  report()
  expect(backs).toEqual([])

  // No action was reported and the location never changed: only the deadline says so.
  passArrivalTimeout()
  await nextTurn()
  expect(backs).toEqual(["goBack"])
})

test("a deadline late from a blocked thread waits again instead of popping", async () => {
  const {
    coreMoves,
    setStack,
    answerWith,
    passArrivalTimeout,
    passArrivalTimeoutAfterStall,
    userBack,
    pendingTimerCount,
  } = setup([list], at("list"))
  const backs: Array<string> = []
  answerWith(async () => {
    backs.push("goBack")
    setStack([list])
    return finished("completed")
  })
  coreMoves([list, detail])
  // The push is still in the router's queue, which has not had a turn.
  userBack()
  passArrivalTimeoutAfterStall()
  await nextTurn()
  expect(backs).toEqual([])
  expect(pendingTimerCount()).toBe(1)

  // On time, with still nothing to show for it, the push was dropped after all.
  passArrivalTimeout()
  await nextTurn()
  expect(backs).toEqual(["goBack"])
})

test("the screen beneath popped while a push waits is followed, then the push", async () => {
  const { controller, history, coreMoves, setStack, answerWith, report } = setup([list], at("list"))
  coreMoves([list, detail])
  report()
  const settingsAgain = entry("settings-again")
  const calls: Array<string> = []
  let stack: ReadonlyArray<StackEntry> = [list, detail, settings]
  answerWith(async (destination) => {
    if (destination === undefined) {
      calls.push("goBack")
      stack = stack.slice(0, -1)
    } else {
      calls.push(`navigate ${destination.route}`)
      stack = [...stack, { ...settingsAgain, route: destination.route }]
    }
    setStack(stack)
    return finished("completed")
  })
  coreMoves([list, detail, settings])
  // Android's hardware back runs ahead of the queued push and pops what had rendered.
  history.splice(0, history.length, at("list"), at("settings", "settings"))
  controller.onLocation(at("list"))
  controller.onLocation(at("settings", "settings"))
  await nextTurn()
  await nextTurn()
  expect(calls).toEqual(["goBack", "goBack", "navigate settings"])
  expect(stack.map(({ nodeId }) => String(nodeId))).toEqual(["list", "settings-again"])
  expect(history).toEqual([at("list"), at("settings", "settings-again")])
})

test("our own back on the way to a push is not read as the user's", async () => {
  const { controller, coreMoves, answerWith, report } = setup([list], at("list"))
  coreMoves([list, detail])
  report()
  let attemptCount = 0
  answerWith(async () => {
    attemptCount++
    return finished("completed")
  })
  coreMoves([list, settings])
  // Back from detail to the untagged root, then the push: two actions, one render.
  controller.onLocation(at("list"))
  controller.onLocation(at("settings", "settings"))
  report()
  await nextTurn()
  expect(attemptCount).toBe(0)
})

test("a move of the user's during a push is not lost", async () => {
  const { coreMoves, userPush, report, answerWith } = setup([list], at("list"))
  const destinations: Array<Destination | undefined> = []
  answerWith(async (destination) => {
    destinations.push(destination)
    return finished("completed")
  })
  coreMoves([list, detail])
  userPush(at("settings"))
  report()
  await nextTurn()
  expect(destinations).toEqual([{ route: "settings", params: {} }])
})

test("entries passed on the way are not user input", async () => {
  const { controller, coreMoves, answerWith } = setup([list], at("list"))
  let attemptCount = 0
  answerWith(async () => {
    attemptCount++
    return finished("completed")
  })
  coreMoves([list, detail, settings])
  controller.onLocation(at("detail", "detail"))
  await nextTurn()
  expect(attemptCount).toBe(0)
})

test("an adoption is recognized even if the core finishes before React delivers", async () => {
  const { controller, history, userPush, report, setStack, answerWith } = setup([list], at("list"))
  answerWith(async () => {
    setStack([list, detail])
    return finished("completed")
  })
  userPush(at("detail"))
  report()
  await nextTurn()
  expect(history).toEqual([at("list"), at("detail", "detail")])
  // React now delivers the same stack, which must change nothing.
  controller.onStack([list, detail])
  expect(history).toHaveLength(2)
})

test("an adoption the user has moved on from does not tag what is on screen", async () => {
  const { history, userPush, userBack, report, setStack, answerWith, coreMoves } = setup(
    [list],
    at("list"),
  )
  let finish = (_: OperationInfo) => {}
  const destinations: Array<Destination | undefined> = []
  answerWith((destination) => {
    destinations.push(destination)
    if (destinations.length === 1) {
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    setStack([list, detail, settings])
    return Promise.resolve(finished("completed"))
  })
  userPush(at("detail"))
  report()
  userPush(at("settings"))
  report()
  setStack([list, detail])
  coreMoves([list, detail])
  finish(finished("completed"))
  await nextTurn()
  await nextTurn()

  expect(destinations.map((destination) => destination?.route)).toEqual(["detail", "settings"])
  expect(history).toEqual([at("list"), at("detail"), at("settings", "settings")])

  // Back now lands on the untagged entry, which is still the adopted one.
  // A `goBack` has no destination; had the entry been wrongly tagged, this untagged
  // location would look like somewhere new, and be navigated to.
  const answers: Array<Destination | undefined> = []
  answerWith(async (destination) => {
    answers.push(destination)
    setStack([list, detail])
    return finished("completed")
  })
  userBack()
  report()
  await nextTurn()
  expect(answers).toEqual([undefined])
})

test("a refused destination returns the router to the core's screen", async () => {
  const { history, userPush, report, errors, answerWith, coreMoves } = setup([list], at("list"))
  answerWith(() => Promise.reject(new Error("refused")))
  userPush(at("settings"))
  report()
  await nextTurn()
  expect(history).toEqual([at("list"), at("list", "list")])
  expect(errors).toHaveLength(1)
  report()

  // The refusal leaves nothing behind that could swallow the next push.
  coreMoves([list, settings])
  expect(history.at(-1)).toEqual(at("settings", "settings"))
})

test("an adoption the core cancels also returns the router", async () => {
  const { history, userPush, report, answerWith } = setup([list], at("list"))
  answerWith(async () => finished("cancelled"))
  userPush(at("settings"))
  report()
  await nextTurn()
  expect(history.at(-1)).toEqual(at("list", "list"))
})

test("an adoption that lands without moving the core is not retried", async () => {
  const { userPush, report, answerWith } = setup([list], at("list"))
  let attemptCount = 0
  answerWith(async () => {
    attemptCount++
    return finished("completed")
  })
  userPush(at("settings"))
  report()
  await nextTurn()
  expect(attemptCount).toBe(1)
})

test("a return waits for the core, one step at a time", async () => {
  const { controller, history, report, coreMoves, setStack, answerWith, userBack } = setup(
    [list],
    at("list"),
  )
  coreMoves([list, detail, settings])
  report()
  let backCount = 0
  answerWith(async () => {
    backCount++
    setStack(backCount === 1 ? [list, detail] : [list])
    return finished("completed")
  })
  userBack()
  userBack()
  report()
  // A stack delivered partway through must not put the first step back.
  controller.onStack([list, detail])
  await nextTurn()
  expect(backCount).toBe(2)
  expect(history).toEqual([at("list")])
})

test("a refused return pushes the screen back, without retrying forever", async () => {
  const { history, report, coreMoves, errors, answerWith, userBack } = setup([list], at("list"))
  coreMoves([list, detail])
  report()
  let attemptCount = 0
  answerWith(() => {
    attemptCount++
    return Promise.reject(new Error("refused"))
  })
  userBack()
  report()
  await nextTurn()
  expect(attemptCount).toBe(1)
  expect(errors).toHaveLength(1)
  expect(history).toEqual([at("list"), at("detail", "detail")])
})

test("a location that moves during a return is handled when the return ends", async () => {
  const { report, coreMoves, setStack, answerWith, userBack, userPush } = setup([list], at("list"))
  coreMoves([list, detail])
  report()
  let finish = (_: OperationInfo) => {}
  const destinations: Array<Destination | undefined> = []
  answerWith((destination) => {
    destinations.push(destination)
    if (destination !== undefined) {
      return Promise.resolve(finished("completed"))
    }
    setStack([list])
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  userBack()
  report()
  userPush(at("settings"))
  report()
  finish(finished("completed"))
  await nextTurn()
  expect(destinations.at(-1)).toEqual({ route: "settings", params: {} })
})

test("results arriving after the session ended touch nothing", async () => {
  const { history, userPush, report, answerWith, endSession, coreMoves } = setup([list], at("list"))
  let finish = (_: OperationInfo) => {}
  answerWith(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  userPush(at("settings"))
  report()
  endSession()
  finish(finished("cancelled"))
  await nextTurn()
  coreMoves([list, settings])
  expect(history).toEqual([at("list"), at("settings")])
})

test("a cold deep link is acted on when its location first arrives", async () => {
  const destinations: Array<Destination> = []
  const controller = new ProjectionController({
    router: {
      push: () => undefined,
      replace: () => undefined,
      tag: () => undefined,
      back: () => undefined,
      shownToken: () => null,
    },
    core: {
      isOpen: () => true,
      readStack: () => [list],
      goBack: async () => finished("completed"),
      navigate: async (destination) => {
        destinations.push(destination)
        return finished("completed")
      },
    },
    initialLocation: at("detail"),
    onError: () => undefined,
    schedule: () => () => undefined,
    now: () => 0,
  })
  controller.onStack([list])
  controller.onLocation(at("detail"))
  await nextTurn()
  expect(destinations).toEqual([{ route: "detail", params: {} }])
})

test("a router that has arrived but not reported it is waited for, not popped", async () => {
  const { coreMoves, setStack, answerWith, passArrivalTimeout, report } = setup([list], at("list"))
  const backs: Array<string> = []
  answerWith(async () => {
    backs.push("goBack")
    setStack([list])
    return finished("completed")
  })
  // The router's own state has moved; only its report, from a render, is behind.
  coreMoves([list, detail])
  passArrivalTimeout()
  await nextTurn()
  expect(backs).toEqual([])
  report()
  await nextTurn()
  expect(backs).toEqual([])
})

test("a deadline that passes after the session ended does nothing", async () => {
  const { coreMoves, setStack, answerWith, passArrivalTimeout, endSession, userBack } = setup(
    [list],
    at("list"),
  )
  const backs: Array<string> = []
  answerWith(async () => {
    backs.push("goBack")
    setStack([list])
    return finished("completed")
  })
  coreMoves([list, detail])
  userBack()
  endSession()
  passArrivalTimeout()
  await nextTurn()
  expect(backs).toEqual([])
})

test("a router that never reports its arrival is taken at its report in the end", async () => {
  const { coreMoves, setStack, answerWith, passArrivalTimeout, pendingTimerCount } = setup(
    [list],
    at("list"),
  )
  const backs: Array<string> = []
  answerWith(async () => {
    backs.push("goBack")
    setStack([list])
    return finished("completed")
  })
  coreMoves([list, detail])
  for (let attempt = 0; attempt < 100 && pendingTimerCount() > 0; attempt++) {
    passArrivalTimeout()
  }
  await nextTurn()
  expect(backs).toEqual(["goBack"])
})

const crashed: OperationInfo = {
  operationId: toOperationId("o"),
  nodeId: toNodeId("n"),
  action: "GoBack",
  status: "failed",
  error: { tag: "Defect", message: "no screen today", defect: true },
}

test("a back the core crashed on is said, and the router returns to the core", async () => {
  const { errors, coreMoves, answerWith, userBack, report } = setup([list], at("list"))
  coreMoves([list, detail])
  report()
  answerWith(async () => crashed)
  userBack()
  report()
  await nextTurn()
  expect(errors).toEqual([expect.objectContaining({ message: expect.stringContaining("crashed") })])
})

test("a deep link the core crashed on is said, and the router returns to the core", async () => {
  const { history, errors, answerWith, userPush, report } = setup([list], at("list"))
  answerWith(async () => crashed)
  userPush(at("detail"))
  report()
  await nextTurn()
  report()
  expect(errors).toEqual([expect.objectContaining({ message: expect.stringContaining("crashed") })])
  expect(history.at(-1)?.destination?.route).toBe("list")
})

test("a deep link the core declined is no crash, and nothing is reported", async () => {
  const { errors, answerWith, userPush, report } = setup([list], at("list"))
  answerWith(async () => ({
    ...crashed,
    error: { tag: "NavigationStackFull", message: "full", defect: false },
  }))
  userPush(at("detail"))
  report()
  await nextTurn()
  expect(errors).toEqual([])
})
