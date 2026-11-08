/** For programmer errors only. Expected failures are `ProtocolError`s or results. */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invariant violated: ${message}`)
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`)
}

/** Reading a slot that the surrounding code has just proved exists. */
export const defined = <A>(value: A | undefined, message: string): A => {
  assert(value !== undefined, message)
  return value
}

/** Reads a key without reaching `toString` and the like through the prototype. */
export const ownValue = <A>(record: { readonly [key: string]: A }, key: string): A | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined
