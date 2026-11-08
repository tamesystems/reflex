import { SESSION_LOG_DRAIN_TIMEOUT_MS } from "@reflex/protocol"
import { createLineReader } from "@reflex/rpc"
import { type Config, loadConfig } from "./config.ts"
import { createMcpServer } from "./mcp.ts"
import { connectToSession } from "./session.ts"

const SERVER_VERSION = "0.0.0"
/** Calls still running when stdin closes get this long to answer, then are cancelled. */
const DRAIN_TIMEOUT_MS = 5_000

/**
 * MCP's stdio transport: messages on stdin and stdout, a line each. Stdout is the
 * protocol's alone, so anything logged goes to stderr. Ends when stdin does.
 */
export const serveMcp = async (config: Config, environment: NodeJS.ProcessEnv): Promise<void> => {
  const write = (...values: ReadonlyArray<unknown>) => console.error(...values)
  console.log = write
  console.info = write
  console.debug = write
  const server = createMcpServer({
    target: config.target,
    version: SERVER_VERSION,
    connect: (target) => connectToSession(loadConfig(environment, target)),
    send: (line) => {
      process.stdout.write(`${line}\n`)
    },
  })
  const read = createLineReader({
    onLine: (line) => server.receive(line),
    onOverflow: () => {
      console.error("error: a message over the frame limit; closing")
      process.stdin.destroy()
    },
  })
  await new Promise<void>((resolve) => {
    process.stdin.on("data", read)
    process.stdin.once("end", resolve)
    process.stdin.once("close", resolve)
  })
  read.flush()
  const timer = setTimeout(() => server.close(), DRAIN_TIMEOUT_MS)
  await server.drained()
  clearTimeout(timer)
  server.close()
  await new Promise<void>((resolve) => {
    const stop = setTimeout(resolve, SESSION_LOG_DRAIN_TIMEOUT_MS)
    process.stdout.write("", () => {
      clearTimeout(stop)
      resolve()
    })
  })
  process.exit(0)
}
