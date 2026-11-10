import type { Message } from "./contracts.ts"

interface Fixture<N extends string = string> {
  readonly name: N
}
const InventoryFixture: Fixture<"InventoryFixture"> = { name: "InventoryFixture" }
const OtherFixture: Fixture<"OtherFixture"> = { name: "OtherFixture" }
type Scenario = { readonly fixtures: readonly Fixture[] }
type CommonFixtures<S extends Record<string, Scenario>> = {
  [K in keyof S]: S[K]["fixtures"][number] extends infer F
    ? F extends Fixture
      ? { [J in keyof S]: F extends S[J]["fixtures"][number] ? true : false }[keyof S] extends true
        ? F
        : never
      : never
    : never
}[keyof S]
interface Session<F> {
  node<const T extends Fixture>(
    fixture: T &
      ([T] extends [F] ? unknown : Message<`${T["name"]} is not a fixture of this scenario`>),
  ): void
}
export declare function open<const S extends Record<string, Scenario>, const K extends keyof S>(
  scenarios: S,
  name: K,
): Session<CommonFixtures<Pick<S, K>>>
const scenarios = {
  fixture: { fixtures: [InventoryFixture] },
  production: { fixtures: [] },
} as const
open(scenarios, "fixture").node(InventoryFixture)
// @ts-expect-error Fixture is absent in production.
open(scenarios, "production").node(InventoryFixture)
// @ts-expect-error Unknown fixture is not a member.
open(scenarios, "fixture").node(OtherFixture)
declare const unknownScenario: keyof typeof scenarios
// @ts-expect-error A union scenario only grants fixtures present in every possible scenario.
open(scenarios, unknownScenario).node(InventoryFixture)

// A base binding cannot know future scenario extensions. Its controls describe reality.
interface Controls {
  readonly scenario: string
  isScenario<const K extends string>(name: K): this is Controls & { readonly scenario: K }
}
declare const controls: Controls
if (controls.isScenario("e2e")) {
  const narrowed: "e2e" = controls.scenario
  void narrowed
}
// @ts-expect-error A base binding must not claim its scenario is still only "production".
const dishonest: "production" = controls.scenario
void dishonest
