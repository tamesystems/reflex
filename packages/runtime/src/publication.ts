import {
  ErrorCode,
  type Json,
  measureJson,
  NODE_STATE_CHARACTERS_MAX,
  NODE_STATE_DEPTH_MAX,
  ProtocolError,
} from "@reflex/protocol"

/** Validate, detach and freeze the public projection before retaining or publishing it. */
export const publishJson = (value: unknown): Json => {
  // Reject accessors before reading them: JSON.stringify must not run application code.
  let budget = NODE_STATE_CHARACTERS_MAX
  const copy = (item: unknown, depth: number): unknown => {
    if (depth > NODE_STATE_DEPTH_MAX || --budget < 0) {
      throw new ProtocolError(
        ErrorCode.ResourceExhausted,
        "State cannot be sent: too-deep or too-large",
      )
    }
    if (item === null || typeof item !== "object") {
      return item
    }
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    ) {
      throw new Error("Public state must contain only plain JSON objects")
    }
    const result: Record<string, unknown> | unknown[] = Array.isArray(item)
      ? []
      : Object.create(null)
    for (const key of Object.keys(item)) {
      if (Array.isArray(item) && (String(Number(key)) !== key || Number(key) >= item.length)) {
        throw new Error("Public arrays cannot contain named properties")
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor || !("value" in descriptor)) {
        throw new Error("Public state cannot contain accessors")
      }
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    // Preserve holes so measureJson rejects them rather than silently dropping them.
    if (Array.isArray(item) && Array.isArray(result)) {
      result.length = item.length
    }
    return result
  }
  value = copy(value, 1)
  const measure = measureJson(value, NODE_STATE_CHARACTERS_MAX, NODE_STATE_DEPTH_MAX)
  if (measure !== "fits") {
    throw new ProtocolError(ErrorCode.ResourceExhausted, `State cannot be sent: ${measure}`)
  }
  const text = JSON.stringify(value)
  if (text.length > NODE_STATE_CHARACTERS_MAX) {
    throw new ProtocolError(ErrorCode.ResourceExhausted, "State cannot be sent: too-large")
  }
  const freeze = (item: Json): Json => {
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) {
        freeze(child)
      }
      Object.freeze(item)
    }
    return item
  }
  return freeze(JSON.parse(text) as Json)
}
