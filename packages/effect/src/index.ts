export { defineCapability, actionBuilder as action } from "./capability.ts"

export { defineScreen } from "./screen.ts"
export type { InferState, InferActions, InferInput, InferError } from "./author-infer.ts"

export { Screen, defineService, defineFixture } from "./author-screen.ts"
export type {
  StateAccess,
  EffectContext,
  NavigationCommand,
  NavigationRefused,
} from "./author-model.ts"
import { defineApp as legacyDefineApp } from "./app.ts"
import { defineNavigation as legacyDefineNavigation } from "./navigation.ts"
import { authorApp } from "./author-app.ts"
import { authorNavigation } from "./author-navigation.ts"
import type { Erased } from "./erased.ts"

export const defineApp: typeof authorApp & typeof legacyDefineApp = ((spec: Erased) =>
  "root" in spec || spec.navigation?.layer !== undefined
    ? legacyDefineApp(spec)
    : authorApp(spec)) as Erased
export const defineNavigation: typeof authorNavigation & typeof legacyDefineNavigation = ((
  first: Erased,
  second: Erased,
) =>
  typeof first === "string"
    ? legacyDefineNavigation(first, second)
    : authorNavigation(first, second)) as Erased
