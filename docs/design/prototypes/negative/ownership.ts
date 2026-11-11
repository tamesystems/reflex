import { mountOwned, type Runtime } from "@reflex/runtime/advanced"
import { Detail } from "../examples/apps/web/src/app.ts"
declare const runtime: Runtime
// @case owned-params | Expected 3 arguments, but got 2.
mountOwned(runtime, Detail)
