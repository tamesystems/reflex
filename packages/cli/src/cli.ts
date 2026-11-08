#!/usr/bin/env bun
import {
  ADVANCE_TIME_MS_MAX,
  boundedText,
  type Json,
  json,
  ProtocolError,
  paramParsers,
  toNodeId,
  WAIT_TIMEOUT_MS_DEFAULT,
  WAIT_TIMEOUT_MS_MAX,
} from "@reflex/protocol"
import type { Client } from "@reflex/rpc"
import {
  type Config,
  loadConfig,
  SESSION_LOG_BYTES_MAX,
  SHUTDOWN_REPLY_TIMEOUT_MS_DEFAULT,
  START_TIMEOUT_MS_DEFAULT,
} from "./config.ts"
import * as commands from "./commands.ts"
import { serveMcp } from "./mcp-stdio.ts"
import { connectToSession, type ServeOptions, serve, start, stop } from "./session.ts"

const BRIDGE_PORT_DEFAULT_TEXT = "8790"

const USAGE = `reflex: inspect and drive an application, headless or live on a device

Usage: reflex [--target headless|device] <command>

  headless (the default) runs an app module here, with no UI.
  device bridges to an app running in development, which dials in.
  Each target has its own session, so both can run at once.

Session
  reflex start <app-module> [--scenario <name>]   Start a background session
  reflex serve <app-module> [--scenario <name>]   Run in the foreground (--stdio for stdin/stdout)
  reflex stop                                     Stop the background session
  reflex status                                   Show app, scenario and available scenarios
  reflex reset [scenario]                         Rebuild the app from a fixture scenario
  reflex --target device start [--host <h>] [--port <p>]
                                                  Start a bridge (default 127.0.0.1:${BRIDGE_PORT_DEFAULT_TEXT})

Inspect
  reflex ls [--schema]                            Focused screen, state and actions
  reflex tree                                     Every active node
  reflex watch                                    Stream events as JSON lines

Agents
  reflex mcp                                      Serve these commands as MCP tools on stdio

Act
  reflex do <action> [json] [--node <id>] [--no-wait] [--timeout <ms>]
  reflex wait <json> [--timeout <ms>]             e.g. '{"focus":"Settings"}'
  reflex sample <action> [--seed <n>]             Generate a valid input
  reflex advance <ms>                             Move virtual time forward

Environment
  REFLEX_TARGET             headless or device, as --target
  REFLEX_APP_WAIT_MS        How long a device session holds a command for an app (default 15000)
  REFLEX_DIR                Session directory, private to its owner (default ./.reflex)
  REFLEX_START_TIMEOUT_MS     How long start waits (default ${START_TIMEOUT_MS_DEFAULT})
  REFLEX_SHUTDOWN_TIMEOUT_MS  How long stop waits for a reply (default ${SHUTDOWN_REPLY_TIMEOUT_MS_DEFAULT})

A background session logs to session.log.<pid> in that directory, up to ${SESSION_LOG_BYTES_MAX} bytes.`

export async function main(
  argv: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const { targetFlag, remaining } = takeTarget(argv)
  const [command, ...rest] = remaining
  if (command === undefined || command === "help" || command === "--help") {
    console.log(USAGE)
    return
  }
  const config = loadConfig(environment, targetFlag)
  switch (command) {
    case "serve":
      return runServe(config, rest)
    case "start": {
      const options = parseServeArguments(config, rest)
      requireBackgroundable(options)
      return print(await start(config, options, rest))
    }
    case "stop":
      parseArguments(rest, { positionalMax: 0 })
      await stop(config)
      return print({ stopped: true })
    case "watch":
      parseArguments(rest, { positionalMax: 0 })
      return watch(config)
    case "mcp":
      parseArguments(rest, { positionalMax: 0 })
      return serveMcp(config, environment)
    default:
      return withClient(config, (client) => runCommand(client, command, rest))
  }
}

function runCommand(client: Client, command: string, rest: ReadonlyArray<string>): Promise<void> {
  switch (command) {
    case "status":
      parseArguments(rest, { positionalMax: 0 })
      return printResult(commands.status(client))
    case "reset":
      return reset(client, rest)
    case "ls":
      return list(client, rest)
    case "tree":
      parseArguments(rest, { positionalMax: 0 })
      return tree(client)
    case "do":
      return doAction(client, rest)
    case "wait":
      return wait(client, rest)
    case "sample":
      return sample(client, rest)
    case "advance":
      return advance(client, rest)
    default:
      throw new Error(`Unknown command "${boundedText(command)}"\n\n${USAGE}`)
  }
}

interface ArgumentSpec {
  readonly positionalMax: number
  readonly valueFlags?: ReadonlyArray<string>
  readonly switches?: ReadonlyArray<string>
}

interface ParsedArguments {
  readonly positional: ReadonlyArray<string>
  readonly values: ReadonlyMap<string, string>
  readonly switches: ReadonlySet<string>
}

/**
 * Anything not in the spec is refused: a misspelled flag is ignored at the cost of
 * doing something other than what was asked, and that something may not be undoable.
 */
function parseArguments(argv: ReadonlyArray<string>, spec: ArgumentSpec): ParsedArguments {
  const positional: Array<string> = []
  const values = new Map<string, string>()
  const switches = new Set<string>()
  const remaining = [...argv]
  while (remaining.length > 0) {
    const argument = remaining.shift() ?? ""
    const flag = argument.slice(2)
    if (!argument.startsWith("--")) {
      positional.push(argument)
    } else if (spec.valueFlags?.includes(flag) === true) {
      values.set(flag, requireFlagValue(argument, remaining.shift(), values))
    } else if (spec.switches?.includes(flag) === true) {
      switches.add(flag)
    } else {
      throw new Error(`Unknown option ${boundedText(argument)}`)
    }
  }
  if (positional.length > spec.positionalMax) {
    throw new Error(`Unexpected argument ${boundedText(positional.at(-1) ?? "")}`)
  }
  return { positional, values, switches }
}

function requireFlagValue(
  flag: string,
  value: string | undefined,
  seen: ReadonlyMap<string, string>,
) {
  if (seen.has(flag.slice(2))) {
    throw new Error(`${flag} was given twice`)
  }
  if (value === undefined) {
    throw new Error(`${flag} needs a value`)
  }
  return value
}

/** Digits only: `Number` also takes "", "0x10" and "1e3". */
function parseIntegerArgument(name: string, text: string, maximum: number): number {
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be an integer from 0 to ${maximum}`)
  }
  const value = Number(text)
  if (value > maximum) {
    throw new Error(`${name} must be an integer from 0 to ${maximum}`)
  }
  return value
}

function parseJsonArgument(what: string, text: string): Json {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${what} must be valid JSON, got: ${boundedText(text)}`)
  }
  return json(value, what)
}

/** `--target` comes before the command, so that every command takes it the same way. */
function takeTarget(argv: ReadonlyArray<string>): {
  readonly targetFlag: string | undefined
  readonly remaining: ReadonlyArray<string>
} {
  if (argv[0] !== "--target") {
    return { targetFlag: undefined, remaining: argv }
  }
  const targetFlag = argv[1]
  if (targetFlag === undefined) {
    throw new Error("--target needs a value: headless or device")
  }
  return { targetFlag, remaining: argv.slice(2) }
}

async function runServe(config: Config, argv: ReadonlyArray<string>): Promise<void> {
  await serve(config, parseServeArguments(config, argv))
}

const BRIDGE_HOST_DEFAULT = "127.0.0.1"
const BRIDGE_PORT_DEFAULT = 8790
const PORT_MAX = 65_535

/** `start` checks these too: its child has no terminal to report a mistake on. */
function parseServeArguments(config: Config, argv: ReadonlyArray<string>): ServeOptions {
  if (config.target === "device") {
    const { values, switches } = parseArguments(argv, {
      positionalMax: 0,
      valueFlags: ["host", "port"],
      switches: ["stdio", "daemon"],
    })
    const portText = values.get("port")
    const port =
      portText === undefined
        ? BRIDGE_PORT_DEFAULT
        : parseIntegerArgument("--port", portText, PORT_MAX)
    // Port 0 would pick a new port each time, and every app would need reconfiguring.
    if (port === 0) {
      throw new Error(`--port must be an integer from 1 to ${PORT_MAX}`)
    }
    const hostname = values.get("host") ?? BRIDGE_HOST_DEFAULT
    return { kind: "bridge", hostname, port, transport: transportOf(switches) }
  }
  const { positional, values, switches } = parseArguments(argv, {
    positionalMax: 1,
    valueFlags: ["scenario"],
    switches: ["stdio", "daemon"],
  })
  const [module] = positional
  if (module === undefined) {
    throw new Error("serve needs an app module")
  }
  return {
    kind: "app",
    module,
    scenario: values.get("scenario"),
    transport: transportOf(switches),
  }
}

function requireBackgroundable({ transport }: ServeOptions): void {
  if (transport === "stdio") {
    throw new Error("A background session has no stdio; use: reflex serve --stdio")
  }
}

function transportOf(switches: ReadonlySet<string>): ServeOptions["transport"] {
  if (switches.has("stdio") && switches.has("daemon")) {
    throw new Error("A session runs over --stdio or as a --daemon, not both")
  }
  if (switches.has("stdio")) {
    return "stdio"
  }
  return switches.has("daemon") ? "daemon" : "socket"
}

async function withClient(config: Config, run: (client: Client) => Promise<void>): Promise<void> {
  const client = await connectToSession(config)
  try {
    await run(client)
  } finally {
    client.close()
  }
}

async function watch(config: Config): Promise<void> {
  const client = await connectToSession(config)
  try {
    client.onEvent((event) => console.log(JSON.stringify(event)))
    await client.request("app.subscribe", {})
    const cause = await client.ended
    if (cause !== null) {
      throw new Error(`The session went away: ${cause.message}`)
    }
  } finally {
    client.close()
  }
}

async function reset(client: Client, argv: ReadonlyArray<string>): Promise<void> {
  const [scenario] = parseArguments(argv, { positionalMax: 1 }).positional
  print(await commands.reset(client, scenario))
}

async function list(client: Client, argv: ReadonlyArray<string>): Promise<void> {
  const { switches } = parseArguments(argv, { positionalMax: 0, switches: ["schema"] })
  print(await commands.list(client, switches.has("schema") ? "with-schema" : "summary"))
}

async function tree(client: Client): Promise<void> {
  print(await commands.tree(client))
}

async function doAction(client: Client, argv: ReadonlyArray<string>): Promise<void> {
  const { positional, values, switches } = parseArguments(argv, {
    positionalMax: 2,
    valueFlags: ["node", "timeout"],
    switches: ["no-wait"],
  })
  const [action, inputText] = positional
  if (action === undefined) {
    throw new Error("do needs an action")
  }
  // Every argument is checked first: an action must not run on a bad command line.
  const timeoutMs = timeoutArgument(values)
  const input = inputText === undefined ? undefined : parseJsonArgument("Input", inputText)
  const nodeId = values.get("node")
  const result = await commands.doAction(client, {
    action,
    ...(input === undefined ? {} : { input }),
    ...(nodeId === undefined ? {} : { nodeId: toNodeId(nodeId) }),
    wait: !switches.has("no-wait"),
    timeoutMs,
  })
  print(result)
  if ("settled" in result && result.operation.status === "failed") {
    throw new ReportedFailure()
  }
}

function timeoutArgument(values: ReadonlyMap<string, string>): number {
  const text = values.get("timeout")
  if (text === undefined) {
    return WAIT_TIMEOUT_MS_DEFAULT
  }
  return parseIntegerArgument("--timeout", text, WAIT_TIMEOUT_MS_MAX)
}

async function wait(client: Client, argv: ReadonlyArray<string>): Promise<void> {
  const { positional, values } = parseArguments(argv, {
    positionalMax: 1,
    valueFlags: ["timeout"],
  })
  const condition = parseJsonArgument("Condition", positional[0] ?? "{}")
  const params = paramParsers["app.wait"](condition, "condition")
  // The flag wins if both are given, and a timeout in the condition is respected otherwise.
  const timeoutMs = values.has("timeout")
    ? timeoutArgument(values)
    : (params.timeoutMs ?? WAIT_TIMEOUT_MS_DEFAULT)
  print(await commands.wait(client, params, timeoutMs))
}

async function sample(client: Client, argv: ReadonlyArray<string>): Promise<void> {
  const { positional, values } = parseArguments(argv, {
    positionalMax: 1,
    valueFlags: ["seed"],
  })
  const [action] = positional
  if (action === undefined) {
    throw new Error("sample needs an action")
  }
  const seedText = values.get("seed")
  const seed =
    seedText === undefined
      ? {}
      : { seed: parseIntegerArgument("--seed", seedText, Number.MAX_SAFE_INTEGER) }
  print(await commands.sample(client, { action, ...seed }))
}

async function advance(client: Client, argv: ReadonlyArray<string>): Promise<void> {
  const [text] = parseArguments(argv, { positionalMax: 1 }).positional
  if (text === undefined) {
    throw new Error("advance needs a duration in milliseconds")
  }
  print(await commands.advance(client, parseIntegerArgument("Duration", text, ADVANCE_TIME_MS_MAX)))
}

async function printResult(result: Promise<unknown>): Promise<void> {
  print(await result)
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

/** The output already says what went wrong; only the exit code is left to set. */
class ReportedFailure extends Error {}

function reportFailure(error: unknown): void {
  process.exitCode = 1
  if (error instanceof ReportedFailure) {
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  const data =
    error instanceof ProtocolError && error.data !== undefined
      ? `\n${boundedText(JSON.stringify(error.data, null, 2))}`
      : ""
  console.error(`error: ${boundedText(message)}${data}`)
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).catch(reportFailure)
}
