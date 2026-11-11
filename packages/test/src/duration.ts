/** Structural Duration.Input compatibility keeps the test client free of an Effect runtime. */
type Unit =
  | "nano"
  | "nanos"
  | "micro"
  | "micros"
  | "milli"
  | "millis"
  | "second"
  | "seconds"
  | "minute"
  | "minutes"
  | "hour"
  | "hours"
  | "day"
  | "days"
  | "week"
  | "weeks"
const scales = {
  weeks: 604800000,
  days: 86400000,
  hours: 3600000,
  minutes: 60000,
  seconds: 1000,
  milliseconds: 1,
  microseconds: 0.001,
  nanoseconds: 0.000001,
}
export type DurationInput =
  | number
  | bigint
  | readonly [number, number]
  | `${number} ${Unit}`
  | "Infinity"
  | "-Infinity"
  | { readonly [K in keyof typeof scales]?: number | undefined }
  | {
      readonly value:
        | { readonly _tag: "Millis"; readonly millis: number }
        | { readonly _tag: "Nanos"; readonly nanos: bigint }
        | { readonly _tag: "Infinity" | "NegativeInfinity" }
    }
export const durationMillis = (input: DurationInput): number => {
  if (typeof input === "number") {
    return input
  }
  if (typeof input === "bigint") {
    return Number(input) / 1e6
  }
  if (typeof input === "string") {
    if (input === "Infinity") {
      return Infinity
    }
    if (input === "-Infinity") {
      return -Infinity
    }
    const match =
      /^(-?\d+(?:\.\d+)?)\s+(nanos?|micros?|millis?|seconds?|minutes?|hours?|days?|weeks?)$/.exec(
        input,
      )
    if (!match) {
      throw new Error(`Invalid duration: ${input}`)
    }
    const unit = match[2]?.replace(/s$/, "")
    const scale = {
      nano: 0.000001,
      micro: 0.001,
      milli: 1,
      second: 1000,
      minute: 60000,
      hour: 3600000,
      day: 86400000,
      week: 604800000,
    }[unit ?? ""]
    if (scale === undefined) {
      throw new Error(`Invalid duration: ${input}`)
    }
    return Number(match[1]) * scale
  }
  if (Array.isArray(input)) {
    return input[0] * 1000 + input[1] / 1e6
  }
  if ("value" in input) {
    const value = input.value
    switch (value._tag) {
      case "Millis":
        return value.millis
      case "Nanos":
        return Number(value.nanos) / 1e6
      case "Infinity":
        return Infinity
      case "NegativeInfinity":
        return -Infinity
    }
  }
  return Object.entries(scales).reduce(
    (total, [unit, scale]) => total + ((input as Record<string, number>)[unit] ?? 0) * scale,
    0,
  )
}
