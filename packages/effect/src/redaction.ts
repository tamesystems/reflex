import {
  defined,
  ErrorCode,
  ProtocolError,
  REDACTION_VISITS_MAX,
  REDACTION_VIEW_BYTES_MAX,
} from "@reflex/protocol"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"

export const REDACTED_TEXT = "<redacted>"

/** Where the search up a prototype chain stops: these hold no user data. */
const BUILT_IN_PROTOTYPES: ReadonlySet<object> = new Set([
  Object.prototype,
  Array.prototype,
  Map.prototype,
  Set.prototype,
  Error.prototype,
  Date.prototype,
  // Some's valueOrUndefined getter reads its own copied value. Other Option
  // properties live on these known prototypes; user subclasses are still scanned.
  Object.getPrototypeOf(Option.some(undefined)),
  Object.getPrototypeOf(Option.none()),
])

type Write = (value: unknown) => void

interface Copying {
  readonly value: unknown
  readonly write: Write
}

/** What a copy needs: the work still to do, and the objects already copied. */
interface CopyContext {
  readonly pending: Array<Copying>
  readonly copies: Map<object, object>
}

/**
 * Replace every `Redacted` in a decoded value, for it to be encoded afterwards.
 *
 * `Schema.Redacted` encodes to plaintext through `Schema.toCodecJson`. Working on
 * the decoded value means secrets are found by what they are, wherever they sit:
 * inside a `Map`, a `Set`, an `Option` or a class, or under a key the schema
 * renames. Encoding reads properties however they are defined, so every own and
 * inherited one is checked here. Four cases fail closed, rather than be encoded:
 *
 * - A secret behind an accessor, because a copy cannot replace what a getter
 *   computes.
 * - A secret on a prototype, because a copy keeps its prototype.
 * - A secret attached to an ArrayBuffer view, whose native slots are kept intact.
 * - A `Redacted` holding anything but a string, because the placeholder is a
 *   string and will not encode as anything else.
 *
 * Copies only when there is a secret, as there usually is not.
 */
export const redact = <A>(root: A): A => {
  if (!containsRedacted(root)) {
    return root
  }
  let result: unknown = root
  const context: CopyContext = {
    copies: new Map(),
    pending: [
      {
        value: root,
        write: (value) => {
          result = value
        },
      },
    ],
  }
  for (let index = 0; index < context.pending.length; index++) {
    requireWithinLimit(index)
    const { value, write } = defined(context.pending[index], "index is within the list")
    copyInto(value, write, context)
  }
  // The copy has the shape of `root`, with secrets swapped for the same type.
  return result as A
}

type Reach = "replaceable" | "out-of-reach" | "opaque-view"

interface Scan {
  readonly value: unknown
  readonly reach: Reach
}

/**
 * Graph-aware, because Effect's own structures, such as `Chunk`, are cyclic inside.
 * An object is seen once per reach: reached replaceably first, it must still be
 * checked if an accessor also leads to it, as the accessor will leak the original.
 */
const containsRedacted = (root: unknown): boolean => {
  const seen: Readonly<Record<Reach, Set<object>>> = {
    replaceable: new Set(),
    "out-of-reach": new Set(),
    "opaque-view": new Set(),
  }
  const pending: Array<Scan> = [{ value: root, reach: "replaceable" }]
  let found = false
  // Popped, as order does not matter here: what is held tracks the work left, not the total.
  for (let visitCount = 0; pending.length > 0; visitCount++) {
    requireWithinLimit(visitCount)
    const { value, reach } = defined(pending.pop(), "the loop checks there is one")
    if (Redacted.isRedacted(value)) {
      if (reach === "opaque-view") {
        throw new Error("A secret attached to an ArrayBuffer view cannot be redacted")
      }
      if (reach === "out-of-reach") {
        throw new Error("A secret behind an accessor or a prototype cannot be redacted")
      }
      found = true
    } else if (ArrayBuffer.isView(value) && !seen[reach].has(value)) {
      if (value.byteLength > REDACTION_VIEW_BYTES_MAX) {
        throw new ProtocolError(
          ErrorCode.ResourceExhausted,
          "ArrayBuffer view is too large to check for secrets",
        )
      }
      seen[reach].add(value)
      // Copies preserve native views' internal slots. Their extra properties
      // therefore cannot be replaced, so secrets on them must fail closed.
      addChildren(value, reach === "replaceable" ? "opaque-view" : reach, pending)
    } else if (isContainer(value) && !seen[reach].has(value)) {
      seen[reach].add(value)
      addChildren(value, reach, pending)
    }
  }
  return found
}

const requireWithinLimit = (visitCount: number): void => {
  if (visitCount >= REDACTION_VISITS_MAX) {
    throw new ProtocolError(ErrorCode.ResourceExhausted, "State is too large to check for secrets")
  }
}

const isContainer = (value: unknown): value is object => {
  if (typeof value !== "object" || value === null) {
    return false
  }
  return !ArrayBuffer.isView(value)
}

const addChildren = (value: object, reach: Reach, pending: Array<Scan>): void => {
  const add = (child: Scan) => {
    requireWithinLimit(pending.length)
    pending.push(child)
  }
  if (value instanceof Map) {
    for (const [key, item] of value) {
      add({ value: key, reach })
      add({ value: item, reach })
    }
  }
  if (value instanceof Set) {
    for (const item of value) {
      add({ value: item, reach })
    }
  }
  let owner: object | null = value
  while (owner !== null && !BUILT_IN_PROTOTYPES.has(owner)) {
    for (const key of Reflect.ownKeys(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)
      if (descriptor !== undefined) {
        add(scanOfProperty({ receiver: value, owner, key, descriptor, reach }))
      }
    }
    owner = Object.getPrototypeOf(owner)
  }
}

const scanOfProperty = (property: {
  readonly receiver: object
  readonly owner: object
  readonly key: string | symbol
  readonly descriptor: PropertyDescriptor
  readonly reach: Reach
}): Scan => {
  const { receiver, owner, key, descriptor, reach } = property
  if ("value" in descriptor) {
    return { value: descriptor.value, reach: owner === receiver ? reach : "out-of-reach" }
  }
  return { value: Reflect.get(receiver, key, receiver), reach: "out-of-reach" }
}

const copyInto = (value: unknown, write: Write, context: CopyContext): void => {
  if (Redacted.isRedacted(value)) {
    if (typeof Redacted.value(value) !== "string") {
      throw new Error("A non-string secret cannot be redacted")
    }
    // A new one each time: secrets in a `Set` are distinct and must stay so.
    write(Redacted.make(REDACTED_TEXT))
  } else if (!isContainer(value)) {
    write(value)
  } else {
    const existing = context.copies.get(value)
    if (existing !== undefined) {
      write(existing)
    } else {
      copyContainer(value, write, context)
    }
  }
}

const copyContainer = (value: object, write: Write, context: CopyContext): void => {
  if (Array.isArray(value)) {
    copyArray(value, write, context)
  } else if (value instanceof Map) {
    copyMap(value, write, context)
  } else if (value instanceof Set) {
    copySet(value, write, context)
  } else {
    copyObject(value, write, context)
  }
}

const copyArray = (
  source: ReadonlyArray<unknown>,
  write: Write,
  { pending, copies }: CopyContext,
): void => {
  const copy = new Array<unknown>(source.length)
  copies.set(source, copy)
  write(copy)
  source.forEach((value, index) => {
    pending.push({
      value,
      write: (item) => {
        copy[index] = item
      },
    })
  })
}

/**
 * Every container, Options included, publishes its copy before queuing children.
 * Key and value callbacks therefore run in FIFO order, preserving insertion order.
 */
const copyMap = (
  source: ReadonlyMap<unknown, unknown>,
  write: Write,
  { pending, copies }: CopyContext,
): void => {
  const copy = new Map<unknown, unknown>()
  copies.set(source, copy)
  write(copy)
  for (const [key, value] of source) {
    pending.push({
      value: key,
      write: (copiedKey) => {
        pending.push({ value, write: (item) => copy.set(copiedKey, item) })
      },
    })
  }
}

const copySet = (
  source: ReadonlySet<unknown>,
  write: Write,
  { pending, copies }: CopyContext,
): void => {
  const copy = new Set<unknown>()
  copies.set(source, copy)
  write(copy)
  for (const value of source) {
    pending.push({ value, write: (item) => copy.add(item) })
  }
}

/**
 * Every own data property is copied, non-enumerable ones included, as an
 * `Error`'s message is. An object with no own properties, such as a `Date`, holds
 * its state where a copy could not reach it, and contains no secret to replace.
 */
const copyObject = (source: object, write: Write, context: CopyContext): void => {
  const keys = Reflect.ownKeys(source)
  if (keys.length === 0) {
    write(source)
    return
  }
  const copy: object = Object.create(Object.getPrototypeOf(source))
  context.copies.set(source, copy)
  write(copy)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor !== undefined) {
      copyProperty(copy, key, descriptor, context)
    }
  }
}

/** Each property is defined once, its final value in hand, so read-only ones work. */
const copyProperty = (
  copy: object,
  key: string | symbol,
  descriptor: PropertyDescriptor,
  { pending }: CopyContext,
): void => {
  if ("value" in descriptor) {
    pending.push({
      value: descriptor.value,
      write: (item) => Object.defineProperty(copy, key, { ...descriptor, value: item }),
    })
  } else {
    Object.defineProperty(copy, key, descriptor)
  }
}
