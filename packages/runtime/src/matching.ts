import { defined } from "@reflex/protocol"

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

/**
 * Does `actual` contain `expected` as a deep subset? Arrays must match in full.
 *
 * `expected` comes from a peer, so this is a work list, not recursion. Its depth
 * and size are limited by the wire parser.
 */
export const matches = (actual: unknown, expected: unknown): boolean => {
  const pending: Array<readonly [unknown, unknown]> = [[actual, expected]]
  while (pending.length > 0) {
    const [left, right] = defined(pending.pop(), "the loop checks there is one")
    if (!isObject(right)) {
      if (left !== right) {
        return false
      }
    } else if (!isObject(left) || Array.isArray(left) !== Array.isArray(right)) {
      return false
    } else if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) {
        return false
      }
      for (let index = 0; index < right.length; index++) {
        pending.push([left[index], right[index]])
      }
    } else {
      for (const [key, value] of Object.entries(right)) {
        if (!Object.hasOwn(left, key)) {
          return false
        }
        pending.push([left[key], value])
      }
    }
  }
  return true
}
