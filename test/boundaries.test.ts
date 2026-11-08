import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")

const isSource = (file: string): boolean => file.endsWith(".ts") || file.endsWith(".tsx")

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(join(root, directory), { recursive: true, encoding: "utf8" })
    .filter(isSource)
    .map((file) => join(root, directory, file))

const importsOf = (file: string): ReadonlyArray<string> => {
  const imports = readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)
  return [...imports].map(([, specifier]) => specifier ?? "").filter((s) => !s.startsWith("."))
}

const isNodeBuiltin = (specifier: string): boolean => specifier.startsWith("node:")
const isEffect = (specifier: string): boolean =>
  specifier === "effect" || specifier.startsWith("effect/")

const violations = (directory: string, permit: (specifier: string) => boolean) =>
  sources(directory).flatMap((file) =>
    importsOf(file)
      .filter((specifier) => !permit(specifier))
      .map((specifier) => `${file}: ${specifier}`),
  )

const allowing =
  (...packages: ReadonlyArray<string>) =>
  (specifier: string): boolean =>
    packages.includes(specifier)

test("protocol depends on nothing", () => {
  expect(violations("packages/protocol/src", allowing())).toEqual([])
})

test("runtime is independent of Effect and of any platform", () => {
  expect(violations("packages/runtime/src", allowing("@reflex/protocol"))).toEqual([])
})

test("rpc stays above the runtime and below the app", () => {
  const permit = allowing("@reflex/protocol", "@reflex/runtime")
  const found = violations("packages/rpc/src", (s) => permit(s) || isNodeBuiltin(s))
  expect(found).toEqual([])
})

test("the Effect integration runs on any JS engine", () => {
  const permit = allowing("@reflex/protocol", "@reflex/runtime")
  expect(violations("packages/effect/src", (s) => permit(s) || isEffect(s))).toEqual([])
})

test("the test kit needs no Effect and no app", () => {
  const permit = allowing("@reflex/protocol", "@reflex/rpc", "@reflex/runtime")
  expect(violations("packages/test/src", permit)).toEqual([])
})

test("the CLI needs no Effect and no app", () => {
  const permit = allowing("@reflex/protocol", "@reflex/rpc", "@reflex/runtime")
  expect(violations("packages/cli/src", (s) => permit(s) || isNodeBuiltin(s))).toEqual([])
})

test("the Expo binding reaches the core through the Effect integration, and serves it over rpc", () => {
  const permit = allowing(
    "@reflex/effect",
    "@reflex/protocol",
    // The connection alone: the rest of rpc speaks Unix sockets, which a phone has not.
    "@reflex/rpc/connection",
    "@reflex/runtime",
    "expo-router",
    // Private, so named one by one; `src/router-actions.ts` is the only user.
    "expo-router/build/global-state/getRouteInfoFromState",
    "expo-router/build/global-state/internalNavigationEvents",
    "react",
  )
  expect(violations("packages/expo/src", permit)).toEqual([])
})

test("application core never imports a UI or device API", () => {
  const found = violations("examples/inventory/src", (s) => isEffect(s) || s === "@reflex/effect")
  expect(found).toEqual([])
})

test("router projection rules need no renderer", () => {
  const files = [
    "projection.ts",
    "projection-controller.ts",
    "route-binding.ts",
    "session-owner.ts",
  ]
  const permit = allowing("@reflex/protocol", "@reflex/runtime")
  for (const file of files) {
    const imports = importsOf(join(root, "packages/expo/src", file))
    expect(imports.filter((specifier) => !permit(specifier))).toEqual([])
  }
})
