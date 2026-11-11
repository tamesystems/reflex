import type { ConsumerDefinition } from "./node-handle.ts"
/** Stable structural identity. Scenarios and fixture instrumentation are deliberately excluded. */
export const descriptorFingerprint = (
  name: string,
  screens: readonly ConsumerDefinition[],
  services: readonly ConsumerDefinition[],
): string => {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) {
      return `[${value.map(canonical).join(",")}]`
    }
    if (value !== null && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map(
          (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`
    }
    return JSON.stringify(value) ?? "null"
  }
  const describe = (definitions: readonly ConsumerDefinition[]) =>
    [...definitions]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((d) => ({ name: d.name, descriptor: d["~reflex"].descriptor?.() ?? {} }))
  const text = canonical({ name, screens: describe(screens), services: describe(services) })
  let first = 2166136261
  let second = 5381
  for (let index = 0; index < text.length; index++) {
    first = Math.imul(first ^ text.charCodeAt(index), 16777619)
    second = Math.imul(second, 33) ^ text.charCodeAt(index)
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`
}
