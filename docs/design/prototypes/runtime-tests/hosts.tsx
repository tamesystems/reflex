import { expect, test } from "bun:test"
import { Screen, defineApp } from "@reflex/effect"
import { createReflex } from "@reflex/react"
import { createReflexRouter } from "@reflex/react-router"
import { createReflexExpo } from "@reflex/expo"
import * as Schema from "effect/Schema"

const Home = Screen.define("Home", { state: Schema.Number, initial: () => 0, actions: () => ({}) })
class Two extends Screen("Two", { state: Schema.Number, initial: () => 0 }) {}
const implementation = Two.implement({ actions: () => ({}) })
const app = defineApp({ name: "fixup2", screens: [Home, implementation] })
const variant = app.withScenarios({ seeded: {} })
const foreign = Screen.define("Home", {
  state: Schema.Number,
  initial: () => 0,
  actions: () => ({}),
})
const alternate = Two.implement({ actions: () => ({}) })
const ForeignTwo = class Two extends Screen("Two", { state: Schema.Number, initial: () => 0 }) {}
const hosts = [
  () => createReflex(app),
  () => createReflexRouter(app, { Home: "/", Two: "/two" }),
  () => createReflexExpo(app, { Home: "/", Two: "/two" }),
]
for (const [index, host] of hosts.entries()) {
  test(`registered one-step screens and accurate foreign/implementation diagnostics (host ${index})`, () => {
    const binding = host()
    expect(binding.from(Home).useScreen).toBeFunction()
    expect(binding.from(Two).useScreen).toBeFunction()
    expect(() => Reflect.apply(binding.from, binding, [foreign])).toThrow("registered contract")
    expect(() => Reflect.apply(binding.from, binding, [ForeignTwo])).toThrow("registered contract")
    expect(() => Reflect.apply(binding.from, binding, [implementation])).toThrow(
      "not its implementation",
    )
    expect(() => Reflect.apply(binding.from, binding, [alternate])).toThrow(
      "not its implementation",
    )
  })
}
test("withApp retains React Router methods and scenario extension", () => {
  const bound = createReflexRouter(app, { Home: "/", Two: "/two" }).withApp(variant)
  expect(bound.href(Home)).toBe("/")
  expect(bound.Link).toBeFunction()
  expect(
    bound.routes({ Home: { element: <p>home</p> }, Two: { element: <p>two</p> } }),
  ).toHaveLength(2)
  expect(() =>
    bound.withApp(defineApp({ name: "fixup2", screens: [Home, implementation] })),
  ).toThrow("withScenarios variant")
})
test("withApp retains Expo methods and projection Provider", () => {
  const bound = createReflexExpo(app, { Home: "/", Two: "/two" }).withApp(variant)
  expect(bound.href(Home)).toEqual({ pathname: "/", params: {} })
  expect(bound.Link).toBeFunction()
  expect(bound.Provider).toBeFunction()
})
class A extends Screen("A", {
  params: { id: Schema.String },
  state: Schema.Number,
  initial: () => 0,
}) {}
class B extends Screen("B", {
  params: { key: Schema.String },
  state: Schema.Number,
  initial: () => 0,
}) {}
const paths = defineApp({
  name: "patterns",
  screens: [A.implement({ actions: () => ({}) }), B.implement({ actions: () => ({}) })],
})
for (const [a, b] of [
  ["/p/:id", "/p/:key"],
  ["/p/:id", "/p/:key/"],
  ["/P/:id", "/p/:key"],
] as const) {
  test(`React Router rejects equivalent patterns ${a} and ${b}`, () => {
    expect(() => createReflexRouter(paths, { A: a, B: b })).toThrow("screens A and B")
  })
}
test("Expo normalizes param names and slashes but preserves case", () => {
  expect(() => createReflexExpo(paths, { A: "/p/[id]", B: "/p/[key]/" })).toThrow("screens A and B")
  expect(createReflexExpo(paths, { A: "/P/[id]", B: "/p/[key]" }).href(A, { id: "x" })).toEqual({
    pathname: "/P/[id]",
    params: { id: "x" },
  })
})

test("static colons inside segments are not parameter placeholders", () => {
  expect(() => createReflexRouter(app, { Home: "/x/foo:id", Two: "/x/foo:key" })).not.toThrow()
})
