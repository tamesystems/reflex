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
    packages.includes(specifier.replace(/\/internal$/, ""))

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

test("live has no framework or platform dependency", () => {
  expect(
    violations(
      "packages/live/src",
      allowing("@reflex/protocol", "@reflex/runtime", "@reflex/rpc/connection"),
    ),
  ).toEqual([])
})

test("React bindings have no native or Expo dependency", () => {
  expect(
    violations(
      "packages/react/src",
      allowing(
        "@reflex/protocol",
        "@reflex/runtime",
        "@reflex/live/session",
        "@reflex/effect",
        "react",
      ),
    ),
  ).toEqual([])
})

test("Expo owns only router integration", () => {
  const permit = allowing(
    "@reflex/effect",
    "@reflex/live",
    "@reflex/protocol",
    "@reflex/runtime",
    "@reflex/live/session",
    "@reflex/react",
    "@reflex/navigation",
    "expo-router",
    "expo-router/build/global-state/getRouteInfoFromState",
    "expo-router/build/global-state/internalNavigationEvents",
    "react",
  )
  expect(violations("packages/expo/src", (s) => permit(s) || isEffect(s))).toEqual([])
})

test("application core never imports a UI or device API", () => {
  const found = violations(
    "examples/inventory/src",
    (s) =>
      isEffect(s) || s.replace(/\/internal$/, "") === "@reflex/effect" || s === "@reflex/protocol",
  )
  expect(found).toEqual([])
})

test("navigation has no framework, router or Effect dependency", () => {
  expect(
    violations("packages/navigation/src", allowing("@reflex/protocol", "@reflex/runtime")),
  ).toEqual([])
})
test("React Router binding stays thin and Effect-free", () => {
  expect(
    violations(
      "packages/react-router/src",
      allowing(
        "@reflex/react",
        "@reflex/live/session",
        "@reflex/runtime",
        "@reflex/protocol",
        "react-router",
      ),
    ),
  ).toEqual([])
})

test("plain example has no Effect or UI dependency", () => {
  expect(
    violations("examples/plain/src", allowing("@reflex/runtime", "zustand/vanilla", "zod")),
  ).toEqual([])
})
test("only explicit capability entries imports Effect at runtime", () => {
  for (const file of [...sources("packages/expo/src"), ...sources("packages/react/src")]) {
    if (file.endsWith("effect.tsx") || file.endsWith("routes-effect.ts")) {
      continue
    }
    expect(importsOf(file).filter((s) => s === "@reflex/effect" || isEffect(s))).toEqual([])
  }
})

test("framework-free consumer depends only on the runtime and live serving", () => {
  expect(
    violations(
      "examples/live-counter/src",
      (s) => allowing("@reflex/live", "@reflex/runtime")(s) || isNodeBuiltin(s),
    ),
  ).toEqual([])
})

test("generic React entry bundles for the browser without Expo, Effect or the bridge", async () => {
  const build = await Bun.build({
    entrypoints: [join(root, "packages/react/src/react.tsx")],
    target: "browser",
    external: ["react", "react/jsx-runtime"],
    plugins: [
      {
        name: "framework-boundary",
        setup(builder) {
          builder.onResolve(
            { filter: /^(expo|react-native|effect|@reflex\/effect)/ },
            ({ path }) => {
              throw new Error(`Generic React entry pulled in ${path}`)
            },
          )
          builder.onLoad({ filter: /[\\/]live[\\/]src[\\/]bridge\.ts$/ }, () => {
            throw new Error("Generic React entry pulled in the live bridge")
          })
        },
      },
    ],
  })
  expect(build.success).toBe(true)
})

test("headless inventory host excludes real HTTP and device storage implementations", async () => {
  const build = await Bun.build({
    entrypoints: [join(root, "examples/inventory/src/app.ts")],
    target: "bun",
    plugins: [
      {
        name: "fixture-service-boundary",
        setup(builder) {
          builder.onLoad({ filter: /(?:http-api|settings-store)\.ts$/ }, () => {
            throw new Error("Headless inventory imported real services")
          })
          builder.onResolve({ filter: /^@react-native-async-storage\// }, () => {
            throw new Error("Headless inventory imported device storage")
          })
        },
      },
    ],
  })
  expect(build.success).toBe(true)
})
