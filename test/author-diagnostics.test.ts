import { expect, test } from "bun:test"
import { Screen, defineApp, defineNavigation } from "@reflex/effect"
import { APP_HOST_ADAPTER } from "@reflex/runtime/internal"
import {
  createController,
  systemTimers,
  type AppHost,
  type Controller,
} from "@reflex/runtime/internal"
import { LiveSessions } from "../packages/live/src/live-sessions.ts"
import { createLiveController } from "../packages/live/src/live-controller.ts"
import { authorMessages } from "../packages/effect/src/author-messages.ts"
import type { Erased } from "../packages/effect/src/erased.ts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

class Page extends Screen("Page", { state: Schema.Number, initial: () => 0 }) {}
const Nav = defineNavigation({ Page })
const Foreign = defineNavigation({ Page }, { key: "foreign" })
const page = Page.implement({
  actions: (a) => ({
    Plain: a({ handler: (): Effect.Effect<void> => Effect.succeed(Nav.back) }),
    Dropped: a({
      handler: () =>
        Effect.sync(() => {
          Nav.back
        }),
    }),
    Missing: a.navigates({ handler: (() => Effect.void) as Erased }),
    Recovery: a.navigates({
      handler: () => Nav.back,
      onRefused: (() => Effect.succeed(Nav.stay)) as Erased,
    }),
    Foreign: a.navigates({ handler: () => Foreign.back }),
  }),
})
const host: AppHost = (defineApp as Erased)({
  name: "diagnostics",
  navigation: Nav.implement([page], { initial: Page }),
})[APP_HOST_ADAPTER]
const messages = {
  Plain: authorMessages.plainNavigation,
  Dropped: authorMessages.discardedCommand,
  Missing: authorMessages.navigationReturn,
  Recovery: authorMessages.refusalRecovery,
  Foreign: authorMessages.foreignNavigator("Foreign", "foreign", ["Page"]),
}
for (const kind of ["session", "live"] as const) {
  test(`author diagnostics survive the ${kind} controller unchanged`, async () => {
    let release = () => {}
    let controller: Controller
    if (kind === "session") {
      controller = await createController(host)
    } else {
      const sessions = new LiveSessions({ timers: systemTimers, onBackgroundError: () => {} })
      release = sessions.open(host, undefined)
      controller = createLiveController(sessions, () => {})
    }
    try {
      for (const [action, message] of Object.entries(messages)) {
        expect(await controller.request("app.dispatch", { action, await: true })).toMatchObject({
          status: "failed",
          error: { defect: true, message },
        })
      }
    } finally {
      await controller.close()
      release()
    }
  })
}
