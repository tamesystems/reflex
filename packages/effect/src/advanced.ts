/** Explicit scoped ownership and custom wire codecs. */
export { mountEffect } from "./mount-effect.ts"
export { jsonCodec } from "./json-codec.ts"
export type {
  StateAccess,
  EffectContext,
  EffectActionBuilder,
  NavigationCommand,
  NavigationRefused,
  StateChanged,
} from "./author-model.ts"
