/** Infrastructure used by sibling bindings and adversarial tests. */
export {
  Registry,
  mountOwned,
  dispatchDecoded,
  liveNodeOf,
  toInputSchema,
  secretFreeEncoder,
  mountWithAccess,
} from "./capability.ts"
export { redact, REDACTED_TEXT } from "./redaction.ts"
export { defineNavigationFactories } from "./navigation.ts"

export type { PublicState } from "./capability.ts"

export { legacyApp } from "./author-app.ts"
export { defineApp as legacyDefineApp } from "./app.ts"
export { defineNavigation as legacyDefineNavigation } from "./navigation.ts"
