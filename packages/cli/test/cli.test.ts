/** Each command is a separate process; only the session persists between them. */
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { WRITE_QUEUE_BYTES_MAX } from "@reflex/protocol"
import { loadConfig } from "../src/config.ts"
import { connectToSession } from "../src/session.ts"
import { nextTurn, waitUntil } from "@reflex/test"

/** A hung command must fail its test, not the whole run. */
const COMMAND_TIMEOUT_MS = 30_000

// Bun ignores bunfig's test.timeout; process journeys need the intended 60 s bound.
setDefaultTimeout(COMMAND_TIMEOUT_MS * 2)

const root = resolve(import.meta.dirname, "../../..")
const directory = mkdtempSync(join(tmpdir(), "reflex-cli-"))

const reflex = (...args: Array<string>) => {
  const result = Bun.spawnSync(["bun", join(root, "packages/cli/src/cli.ts"), ...args], {
    cwd: root,
    env: { ...process.env, REFLEX_DIR: directory },
    timeout: COMMAND_TIMEOUT_MS,
  })
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

/** What the commands under test print. All optional: each prints a subset. */
interface CommandOutput {
  readonly name?: string
  readonly state?: unknown
  readonly settled?: boolean
  readonly input?: unknown
  readonly actions?: ReadonlyArray<{
    readonly name: string
    readonly inputSchema?: { readonly required?: ReadonlyArray<string> }
  }>
  readonly nodes?: ReadonlyArray<{ readonly name: string }>
  readonly operation?: { readonly status: string; readonly operationId: string }
}

const json = (...args: Array<string>): CommandOutput => {
  const result = reflex(...args)
  if (result.code !== 0) {
    throw new Error(`reflex ${args.join(" ")}: ${result.err}`)
  }
  // Output of the program under test, whose assertions are what check its shape.
  return JSON.parse(result.out) as CommandOutput
}

beforeAll(() => {
  const started = reflex("start", "examples/inventory/src/app.ts")
  if (started.code !== 0) {
    throw new Error(started.err)
  }
})

afterAll(() => {
  reflex("stop")
  rmSync(directory, { recursive: true, force: true })
})

/**
 * Reset fixtures through the real wire, avoiding two extra process starts for
 * every assertion. The command under test still runs in its own CLI process;
 * reset and wait have dedicated command tests below.
 */
beforeEach(async () => {
  const client = await connectToSession(loadConfig({ ...process.env, REFLEX_DIR: directory }))
  try {
    await client.request("app.reset", { scenario: "inventory-with-products" })
    await client.request("app.wait", { focus: "InventoryList", match: { _tag: "ready" } })
  } finally {
    client.close()
  }
})

const openDetail = () => json("do", "OpenProduct", '{"productId":"product-123"}')

test("state persists across separate CLI invocations", () => {
  expect(json("ls").name).toBe("InventoryList")

  const opened = openDetail()
  expect(opened).toMatchObject({
    settled: true,
    now: { name: "InventoryDetail", state: { quantity: 5 } },
  })

  json("do", "SetQuantity", '{"quantity":12}')
  expect(json("ls").state).toMatchObject({ quantity: 12 })

  const names = json("ls").actions?.map((action) => action.name)
  expect(names).toEqual(expect.arrayContaining(["Increment", "Save", "GoBack", "FailNextSave"]))
})

test("a failed operation sets the exit code", () => {
  openDetail()
  json("do", "FailNextSave")
  const result = reflex("do", "Save")
  expect(result.code).toBe(1)
  expect(JSON.parse(result.out).operation).toMatchObject({
    status: "failed",
    error: { tag: "ApiError" },
  })
})

test("protocol errors go to stderr with detail", () => {
  openDetail()
  const result = reflex("do", "Nope")
  expect(result.code).toBe(1)
  expect(result.out).toBe("")
  expect(result.err).toContain('Nothing here accepts "Nope"')
  expect(result.err).toContain("Increment")
})

test("ls --schema shows how to call each action", () => {
  openDetail()
  const action = json("ls", "--schema").actions?.find((a) => a.name === "SetQuantity")
  expect(action?.inputSchema?.required).toEqual(["quantity"])
})

test("sample generates an input the action accepts", () => {
  openDetail()
  const { input } = json("sample", "SetQuantity", "--seed", "5")
  expect(json("do", "SetQuantity", JSON.stringify(input)).operation?.status).toBe("completed")
})

test("reset and virtual time work from the terminal", () => {
  expect(json("reset", "slow-network")).toMatchObject({
    scenario: "slow-network",
    capabilities: { virtualTime: true },
  })
  json("wait", '{"focus":"InventoryList","match":{"_tag":"ready"}}')
  openDetail()

  const started = json("do", "Save", "--no-wait")
  expect(started.operation?.status).toBe("running")
  json("wait", '{"match":{"_tag":"saving"}}')
  json("advance", "5000")
  json("wait", `{"operationId":"${started.operation?.operationId}"}`)
  expect(json("ls").state).toMatchObject({ _tag: "editing", error: "Save timed out" })
})

test("do reports an operation it cannot wait out, instead of hanging", () => {
  json("reset", "slow-network")
  json("wait", '{"focus":"InventoryList","match":{"_tag":"ready"}}')
  openDetail()
  const result = json("do", "Save", "--timeout", "10")
  expect(result).toMatchObject({ operation: { status: "running" }, settled: false })
})

test("a timeout inside a wait condition is respected", () => {
  const result = reflex("wait", '{"focus":"Never","timeoutMs":5}')
  expect(result.code).toBe(1)
  expect(result.err).toContain("within 5ms")
})

test("numeric arguments are validated before anything is sent", () => {
  expect(reflex("advance", "").code).toBe(1)
  expect(reflex("advance", "soon").err).toContain("must be an integer")
  expect(reflex("wait", "{}", "--timeout", "-1").err).toContain("must be an integer")
  expect(reflex("sample", "Refresh", "--seed", "1.5").err).toContain("must be an integer")
  expect(reflex("wait", '{"idle":"yes"}').code).toBe(1)
})

test("an action does not run on a bad command line", () => {
  openDetail()
  expect(reflex("do", "Increment", "--timeout", "soon").code).toBe(1)
  expect(reflex("do", "Increment", "{}", "--timeuot", "10").err).toContain("Unknown option")
  expect(reflex("do", "Increment", "{}", "extra").err).toContain("Unexpected argument")
  expect(reflex("do", "Increment", "--timeout", "0x10").code).toBe(1)
  expect(reflex("do", "Increment", "--timeout", "1", "--timeout", "2").code).toBe(1)
  expect(reflex("do", "SetQuantity", "not json").code).toBe(1)
  expect(json("ls").state).toMatchObject({ quantity: 5 })
})

test("tree lists every node", () => {
  openDetail()
  const { nodes } = json("tree")
  expect(nodes?.map((node) => node.name)).toEqual(
    expect.arrayContaining(["InventoryFixture", "Navigation", "InventoryList", "InventoryDetail"]),
  )
})

test("--stdio speaks the protocol on stdin and stdout", async () => {
  const child = Bun.spawn(
    [
      "bun",
      join(root, "packages/cli/src/cli.ts"),
      "serve",
      "examples/inventory/src/app.ts",
      "--stdio",
    ],
    {
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
    },
  )
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.describe" })}\n`)
  await child.stdin.flush()
  const reader = child.stdout.getReader()
  const { value } = await reader.read()
  expect(JSON.parse(new TextDecoder().decode(value))).toMatchObject({
    id: 1,
    result: { app: "inventory" },
  })
  child.stdin.end()
  expect(await child.exited).toBe(0)
}, 10_000)

test("a stdio session ends when its peer sends an endless frame", async () => {
  const child = Bun.spawn(
    [
      "bun",
      join(root, "packages/cli/src/cli.ts"),
      "serve",
      "examples/inventory/src/app.ts",
      "--stdio",
    ],
    { cwd: root, stdin: "pipe", stdout: "ignore", stderr: "ignore" },
  )
  // The session hangs up partway through, so a later write may fail: that is the point.
  const chunk = "x".repeat(1024 * 1024)
  try {
    for (let index = 0; index < 10; index++) {
      await child.stdin.write(chunk)
      await child.stdin.flush()
    }
  } catch {
    // Writing to a process that has already gone.
  }
  expect(await child.exited).toBe(0)
}, 15_000)

test("commands without a session explain what to do", () => {
  const empty = mkdtempSync(join(tmpdir(), "reflex-none-"))
  const result = Bun.spawnSync(["bun", join(root, "packages/cli/src/cli.ts"), "ls"], {
    cwd: root,
    env: { ...process.env, REFLEX_DIR: empty },
  })
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain("reflex start")
  rmSync(empty, { recursive: true, force: true })
})

type Reflex = (...args: Array<string>) => ReturnType<typeof reflex>

const directories = new WeakMap<Reflex, string>()
const dirOf = (cli: Reflex): string => {
  const dir = directories.get(cli)
  if (dir === undefined) {
    throw new Error("an isolated CLI knows its directory")
  }
  return dir
}

const isolated = (run: (cli: Reflex, dir: string) => void | Promise<void>) => async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflex-iso-"))
  const cli = (...args: Array<string>) => {
    const result = Bun.spawnSync(["bun", join(root, "packages/cli/src/cli.ts"), ...args], {
      cwd: root,
      // Short, so that a device session with no app answers well inside a test.
      env: { ...process.env, REFLEX_DIR: dir, REFLEX_APP_WAIT_MS: "500" },
      timeout: COMMAND_TIMEOUT_MS,
    })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }
  directories.set(cli, dir)
  try {
    await run(cli, dir)
  } finally {
    cli("stop")
    rmSync(dir, { recursive: true, force: true })
  }
}

test(
  "stop never signals a process named in a stale file",
  isolated(async (cli, dir) => {
    const unrelated = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      await Bun.write(join(dir, "session.lock"), String(unrelated.pid))
      const result = cli("stop")
      expect(result.code).toBe(1)
      expect(result.err).toContain(String(unrelated.pid))
      expect(unrelated.exitCode).toBeNull()
      expect(unrelated.killed).toBe(false)
    } finally {
      unrelated.kill()
      await unrelated.exited
      rmSync(join(dir, "session.lock"), { force: true })
    }
  }),
  15_000,
)

test(
  "a lock left by a dead process does not block a new session",
  isolated(async (cli, dir) => {
    const dead = Bun.spawnSync(["bun", "-e", "console.log(process.pid)"]).stdout.toString().trim()
    await Bun.write(join(dir, "session.lock"), dead)
    expect(cli("start", "examples/inventory/src/app.ts").code).toBe(0)
    expect(cli("stop").code).toBe(0)
  }),
  15_000,
)

test(
  "only one of two simultaneous starts wins, and stop leaves nothing",
  isolated(async (_, dir) => {
    const start = () =>
      Bun.spawn(
        ["bun", join(root, "packages/cli/src/cli.ts"), "start", "examples/inventory/src/app.ts"],
        {
          cwd: root,
          env: { ...process.env, REFLEX_DIR: dir },
          stdout: "ignore",
          stderr: "pipe",
        },
      )
    const pair = [start(), start()]
    const codes = (await Promise.all(pair.map((child) => child.exited))).sort()
    expect(codes).toEqual([0, 1])
    const loser = pair.find((child) => child.exitCode === 1)
    expect(await new Response(loser?.stderr).text()).toContain("already running")

    const stop = Bun.spawnSync(["bun", join(root, "packages/cli/src/cli.ts"), "stop"], {
      cwd: root,
      env: { ...process.env, REFLEX_DIR: dir },
    })
    expect(stop.exitCode).toBe(0)
    const remaining = new Bun.Glob("session.*").scanSync({ cwd: dir, dot: true })
    expect([...remaining]).toEqual([])
  }),
  20_000,
)

test("shutdown is refused inside a batch, so its reply is not lost", async () => {
  const { createConnection } = await import("@reflex/rpc")
  const { createController } = await import("@reflex/runtime")
  const { default: app } = await import("../../../examples/inventory/src/app.ts")
  const controller = await createController(app)
  let shutdowns = 0
  const lines: Array<unknown> = []
  const connection = createConnection(controller, (line) => lines.push(JSON.parse(line)), {
    onShutdown: () => shutdowns++,
  })
  connection.receive(
    JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "session.shutdown" },
      { jsonrpc: "2.0", id: 2, method: "app.describe" },
    ]),
  )
  await waitUntil(() => lines.length > 0, "the batch is answered")
  expect(shutdowns).toBe(0)
  expect(lines[0]).toMatchObject([{ id: 1, error: { code: -32601 } }, { id: 2 }])
  connection.close()
  await controller.close()
})

test(
  "two starts reclaiming one dead lock produce one session",
  isolated(async (_, dir) => {
    const dead = Bun.spawnSync(["bun", "-e", "console.log(process.pid)"]).stdout.toString().trim()
    await Bun.write(join(dir, "session.lock"), dead)
    const start = () =>
      Bun.spawn(
        ["bun", join(root, "packages/cli/src/cli.ts"), "start", "examples/inventory/src/app.ts"],
        {
          cwd: root,
          env: { ...process.env, REFLEX_DIR: dir },
          stdout: "ignore",
          stderr: "ignore",
        },
      )
    const codes = (
      await Promise.all([start(), start(), start()].map((child) => child.exited))
    ).sort()
    expect(codes).toEqual([0, 1, 1])
  }),
  20_000,
)

test(
  "a start that gives up leaves no session behind",
  isolated(async (cli, dir) => {
    const module = join(dir, "never.ts")
    await Bun.write(module, "await new Promise(() => {}); export default {}")
    const result = Bun.spawnSync(["bun", join(root, "packages/cli/src/cli.ts"), "start", module], {
      cwd: root,
      env: { ...process.env, REFLEX_DIR: dir, REFLEX_START_TIMEOUT_MS: "300" },
    })
    expect(result.exitCode).toBe(1)
    expect(cli("status").code).toBe(1)
    // The killed child leaves its lock behind, and it must not block a real start.
    expect(cli("start", "examples/inventory/src/app.ts").code).toBe(0)
  }),
  15_000,
)

// This Unix peer has no Windows authentication handshake.
test.skipIf(process.platform === "win32")(
  "stop gives up on a socket that never answers",
  isolated(async (_cli, dir) => {
    const { createServer } = await import("node:net")
    const silent = createServer(() => {})
    await new Promise<void>((resolve) => silent.listen(join(dir, "session.sock"), resolve))
    // spawnSync would block the event loop this listener needs.
    const child = Bun.spawn(["bun", join(root, "packages/cli/src/cli.ts"), "stop"], {
      cwd: root,
      env: { ...process.env, REFLEX_DIR: dir },
      stdout: "ignore",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain("not responding")
    silent.close()
  }),
  15_000,
)

test(
  "an invalid start timeout is refused, not silently ignored",
  isolated((_, dir) => {
    const result = Bun.spawnSync(["bun", join(root, "packages/cli/src/cli.ts"), "stop"], {
      cwd: root,
      env: { ...process.env, REFLEX_DIR: dir, REFLEX_START_TIMEOUT_MS: "abc" },
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("REFLEX_START_TIMEOUT_MS")
  }),
  15_000,
)

// Windows ACL coverage lives in windows.test.ts; chmod cannot express it.
test.skipIf(process.platform === "win32")(
  "a session directory others can read is refused",
  isolated((cli, dir) => {
    chmodSync(dir, 0o755)
    const result = cli("start", "examples/inventory/src/app.ts")
    expect(result.code).toBe(1)
    expect(result.err).toContain("accessible only to its owner")
    chmodSync(dir, 0o700)
  }),
  15_000,
)

test(
  "a module that is not an app is refused",
  isolated(async (cli, dir) => {
    const module = join(dir, "not-an-app.ts")
    await Bun.write(module, "export default { start: true }")
    const result = cli("start", module)
    expect(result.code).toBe(1)
    expect(result.err).toContain("must export an app")
  }),
  15_000,
)

const CLI = join(root, "packages/cli/src/cli.ts")

const appModule = (body: string) => `
  import inventory from ${JSON.stringify(pathToFileURL(join(root, "examples/inventory/src/app.ts")).href)}
  ${body}
`

const inventoryApp = "examples/inventory/src/app.ts"

test(
  "a mutex left by a crash does not block recovery for long",
  isolated((cli, dir) => {
    const dead = Bun.spawnSync(["bun", "-e", "console.log(process.pid)"]).stdout.toString().trim()
    writeFileSync(join(dir, "session.lock"), dead)
    const mutex = join(dir, "session.reclaim")
    mkdirSync(mutex)
    expect(cli("start", inventoryApp).code).toBe(1)
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(mutex, longAgo, longAgo)
    expect(cli("start", inventoryApp).code).toBe(0)
  }),
  15_000,
)

test(
  "an app with a malformed scenario fails to start and leaves nothing running",
  isolated(async (cli, dir) => {
    const module = join(dir, "malformed.ts")
    await Bun.write(
      module,
      `export default {
        name: "x",
        defaultScenario: "a",
        scenarios: [{ name: "a" }],
        start: async () => { throw new Error("must not get this far") },
      }`,
    )
    expect(cli("start", module).code).toBe(1)
    expect(cli("status").code).toBe(1)
  }),
  15_000,
)

test(
  "a failed start reports its reason, not the app's first log line",
  isolated(async (cli, dir) => {
    const module = join(dir, "noisy.ts")
    await Bun.write(
      module,
      appModule(`
        console.log("loading inventory cache")
        export default { ...inventory, start: async () => { throw new Error("no database") } }
      `),
    )
    const result = cli("start", module)
    expect(result.code).toBe(1)
    expect(result.err).toContain("no database")
    expect(result.err).not.toContain("inventory cache")
  }),
  15_000,
)

test(
  "a session whose disposal fails still ends",
  isolated(async (cli, dir) => {
    const module = join(dir, "bad-dispose.ts")
    await Bun.write(
      module,
      appModule(`
        export default {
          ...inventory,
          start: async (name, options) => ({
            ...(await inventory.start(name, options)),
            dispose: () => Promise.reject(new Error("bad dispose")),
          }),
        }
      `),
    )
    expect(cli("start", module).code).toBe(0)
    expect(cli("stop").code).toBe(0)
    expect(cli("status").code).toBe(1)
  }),
  15_000,
)

test(
  "a foreground session keeps its errors on stderr",
  isolated((cli) => {
    expect(cli("start", inventoryApp).code).toBe(0)
    const result = cli("serve", inventoryApp)
    expect(result.code).toBe(1)
    expect(result.err).toContain("already running")
  }),
  15_000,
)

test(
  "what an app logs in stdio mode stays out of the protocol stream",
  isolated(async (_, dir) => {
    const module = join(dir, "chatty.ts")
    await Bun.write(
      module,
      appModule(`
        console.info("chatting")
        console.log("chatting")
        console.debug("chatting")
        export default inventory
      `),
    )
    const child = Bun.spawn(["bun", CLI, "serve", module, "--stdio"], {
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    const ask = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.describe" })
    await child.stdin.write(`${ask}\n`)
    await child.stdin.end()
    expect(await child.exited).toBe(0)
    const output = await new Response(child.stdout).text()
    expect(output).not.toContain("chatting")
    expect(JSON.parse(output.trim())).toMatchObject({ id: 1 })
  }),
  15_000,
)

test(
  "a daemon's log stops at its limit",
  isolated(async (cli, dir) => {
    const module = join(dir, "loud.ts")
    await Bun.write(
      module,
      appModule(`
        for (let index = 0; index < 3000; index++) {
          console.log("x".repeat(1024))
        }
        export default inventory
      `),
    )
    expect(cli("start", module).code).toBe(0)
    const [log] = [...new Bun.Glob("session.log.*").scanSync({ cwd: dir, dot: true })]
    expect(log).toBeDefined()
    expect(Bun.file(join(dir, log ?? "")).size).toBeLessThanOrEqual(1024 * 1024)
    expect(Bun.file(join(dir, log ?? "")).size).toBeGreaterThan(1024 * 1000)
  }),
  15_000,
)

test(
  "stop and watch refuse arguments they do not take, before doing anything",
  isolated((cli) => {
    expect(cli("start", inventoryApp).code).toBe(0)
    expect(cli("stop", "--force").err).toContain("Unknown option")
    expect(cli("stop", "now").err).toContain("Unexpected argument")
    expect(cli("watch", "--all").err).toContain("Unknown option")
    expect(cli("status").code).toBe(0)
  }),
  15_000,
)

test(
  "start reports a bad command line itself",
  isolated((cli) => {
    expect(cli("start").err).toContain("needs an app module")
    expect(cli("start", inventoryApp, "--bogus").err).toContain("Unknown option")
    expect(cli("status").code).toBe(1)
  }),
  15_000,
)

test("an empty session directory is refused, not taken for the current one", () => {
  const result = Bun.spawnSync(["bun", CLI, "status"], {
    cwd: root,
    env: { ...process.env, REFLEX_DIR: "" },
    timeout: COMMAND_TIMEOUT_MS,
  })
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain("REFLEX_DIR")
})

test(
  "a noisy app cannot crowd out why it failed",
  isolated(async (cli, dir) => {
    const module = join(dir, "noisy-failure.ts")
    await Bun.write(
      module,
      appModule(`
        for (let index = 0; index < 3000; index++) {
          console.log("x".repeat(1023))
        }
        const reason = "no database" + "!".repeat(5000)
        export default { ...inventory, start: async () => { throw new Error(reason) } }
      `),
    )
    expect(cli("start", module).err).toContain("no database")
  }),
  15_000,
)

test(
  "logging an object costs a summary, not a rendering",
  isolated(async (cli, dir) => {
    const module = join(dir, "objects.ts")
    await Bun.write(
      module,
      appModule(`
        console.log({
          toString() { throw new Error("rendered") },
          [Symbol.for("nodejs.util.inspect.custom")]() { throw new Error("rendered") },
        })
        console.log(Object.create(null))
        export default inventory
      `),
    )
    expect(cli("start", module).code).toBe(0)
  }),
  15_000,
)

test(
  "a stdio session whose disposal fails still exits, and says so",
  isolated(async (_, dir) => {
    const module = join(dir, "bad-stdio.ts")
    await Bun.write(
      module,
      appModule(`
        setInterval(() => {}, 1000)
        export default {
          ...inventory,
          start: async (name, options) => ({
            ...(await inventory.start(name, options)),
            dispose: () => Promise.reject(new Error("bad dispose")),
          }),
        }
      `),
    )
    const child = Bun.spawn(["bun", CLI, "serve", module, "--stdio"], {
      cwd: root,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    })
    await child.stdin.end()
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain("bad dispose")
  }),
  15_000,
)

test(
  "watch reports losing its session, rather than exiting as if all were well",
  isolated(async (cli, dir) => {
    expect(cli("start", inventoryApp).code).toBe(0)
    const watcher = Bun.spawn(["bun", CLI, "watch"], {
      cwd: root,
      env: { ...process.env, REFLEX_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    })
    // It prints once subscribed, which has to be true before the session stops.
    let printed = false
    watcher.stdout
      .getReader()
      .read()
      .then(() => {
        printed = true
      })
      .catch(() => undefined)
    for (let attempt = 0; attempt < 100 && !printed; attempt++) {
      cli("reset")
      await nextTurn()
    }
    expect(printed).toBe(true)
    cli("stop")
    expect(await watcher.exited).toBe(1)
    expect(await new Response(watcher.stderr).text()).toContain("went away")
  }),
  20_000,
)

test(
  "start refuses a mode it cannot run in the background",
  isolated((cli) => {
    const result = cli("start", inventoryApp, "--stdio")
    expect(result.code).toBe(1)
    expect(result.err).toContain("reflex serve --stdio")
  }),
  15_000,
)

test("closing stdin answers what was asked, including a last line with no newline", async () => {
  const child = Bun.spawn(["bun", CLI, "serve", inventoryApp, "--stdio"], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  // Still running when stdin closes, which is the point: its answer must not be lost.
  const params = { focus: "Never", timeoutMs: 400 }
  const wait = { jsonrpc: "2.0", id: 1, method: "app.wait", params }
  const describe = { jsonrpc: "2.0", id: 2, method: "app.describe" }
  await child.stdin.write(`${JSON.stringify(wait)}\n${JSON.stringify(describe)}`)
  await child.stdin.end()
  expect(await child.exited).toBe(0)
  const replies = (await new Response(child.stdout).text())
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line))
  expect(replies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({ id: 2 }),
    ]),
  )
}, 15_000)

test(
  "a broken stdout ends the session with its app disposed",
  isolated(async (_, dir) => {
    const marker = join(dir, "disposed")
    const module = join(dir, "marks.ts")
    await Bun.write(
      module,
      appModule(`
        import { writeFileSync } from "node:fs"
        export default {
          ...inventory,
          start: async (name, options) => {
            const session = await inventory.start(name, options)
            return {
              ...session,
              dispose: async () => {
                writeFileSync(${JSON.stringify(marker)}, "yes")
                await session.dispose()
              },
            }
          },
        }
      `),
    )
    const child = Bun.spawn(["bun", CLI, "serve", module, "--stdio"], {
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    const reader = child.stdout.getReader()
    const ask = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.describe" })}\n`
    await child.stdin.write(ask)
    await child.stdin.flush()
    await reader.read()
    await reader.cancel()
    // Stdin stays open: this must end because of stdout, not because input ran out.
    let exited = false
    child.exited.then(() => {
      exited = true
    })
    const deadlineUnixMs = Date.now() + 5_000
    while (!exited && Date.now() < deadlineUnixMs) {
      try {
        await child.stdin.write(ask)
        await child.stdin.flush()
      } catch {
        // The session may already have gone, which is what this test is about.
      }
      await nextTurn()
    }
    const ended = exited
    child.kill()
    expect(ended).toBe(true)
    expect(existsSync(marker)).toBe(true)
  }),
  15_000,
)

test(
  "a full log keeps its limit with the failure in it",
  isolated(async (cli, dir) => {
    const module = join(dir, "full-log.ts")
    // Lines this size fill the log exactly, were no room kept back for the failure.
    await Bun.write(
      module,
      appModule(`
        for (let index = 0; index < 3000; index++) {
          console.log("x".repeat(1023))
        }
        export default {
          ...inventory,
          start: async (name, options) => ({
            ...(await inventory.start(name, options)),
            dispose: () => Promise.reject(new Error("bad dispose" + "!".repeat(5000))),
          }),
        }
      `),
    )
    expect(cli("start", module).code).toBe(0)
    expect(cli("stop").code).toBe(0)
    await waitUntil(() => cli("status").code === 1, "the session to end")
    const [log] = [...new Bun.Glob("session.log.*").scanSync({ cwd: dir, dot: true })]
    expect(log).toBeDefined()
    const file = Bun.file(join(dir, log ?? ""))
    expect(file.size).toBeLessThanOrEqual(1024 * 1024)
    expect(await file.text()).toContain("bad dispose")
  }),
  15_000,
)

/** Asks for replies of about 5 MiB each, then reads none of them for a while. */
const askSlowly = async (options: {
  readonly inspectionCount: number
  readonly thenCloseStdin: boolean
}): Promise<string> => {
  const { inspectionCount, thenCloseStdin } = options
  const child = Bun.spawn(["bun", CLI, "serve", inventoryApp, "--stdio"], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  const ask = (id: number, method: string, params: unknown) =>
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
  const productId = "p".repeat(1024 * 1024)
  const navigate = {
    action: "Navigate",
    input: { route: "InventoryDetail", params: { productId } },
    await: true,
  }
  const inspections = Array.from({ length: inspectionCount }, (_, index) =>
    ask(index + 2, "app.inspect", { tree: true }),
  )
  await child.stdin.write(ask(1, "app.dispatch", navigate) + inspections.join(""))
  await child.stdin.flush()
  if (thenCloseStdin) {
    await child.stdin.end()
  }
  // What the pipe cannot take yet sits in the session, waiting to go.
  await Bun.sleep(1_000)
  const output = await new Response(child.stdout).text()
  await child.exited
  return output
}

test("replies far larger than the pipe are written out in full before exiting", async () => {
  const replies = (await askSlowly({ inspectionCount: 3, thenCloseStdin: true }))
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line))
  expect(replies.map((reply) => (reply as { id: number }).id).toSorted()).toEqual([1, 2, 3, 4])
}, 20_000)

test("a peer that stops reading is hung up on at the limit, input still open", async () => {
  const output = await askSlowly({ inspectionCount: 10, thenCloseStdin: false })
  expect(output.length).toBeLessThan(WRITE_QUEUE_BYTES_MAX)
}, 20_000)

for (const [how, crash] of [
  ["an exception", `throw new Error("late crash")`],
  ["a rejection", `Promise.reject(new Error("late crash"))`],
]) {
  test(
    `${how} that kills a daemon reaches its log, and frees its lock`,
    isolated(async (cli, dir) => {
      const trigger = join(dir, "crash-now")
      const module = join(dir, "crashes.ts")
      await Bun.write(
        module,
        appModule(`
          import { existsSync } from "node:fs"
          const timer = setInterval(() => {
            if (existsSync(${JSON.stringify(trigger)})) {
              clearInterval(timer)
              ${crash}
            }
          }, 10)
          export default inventory
        `),
      )
      expect(cli("start", module).code).toBe(0)
      writeFileSync(trigger, "")
      await waitUntil(() => !existsSync(join(dir, "session.lock")), "the daemon to die")
      const [log] = [...new Bun.Glob("session.log.*").scanSync({ cwd: dir, dot: true })]
      expect(log).toBeDefined()
      expect(await Bun.file(join(dir, log ?? "")).text()).toContain("late crash")
    }),
    15_000,
  )
}

// Windows has no POSIX FIFO; FrameSink units and the process write-budget tests still run there.
test.skipIf(process.platform === "win32")(
  "a peer that never reads is given up on, once stdin has closed",
  async () => {
    // A pipe of Bun's own would be read for us, however little this test reads.
    const dir = mkdtempSync(join(tmpdir(), "reflex-fifo-"))
    const fifo = join(dir, "out")
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0)
    const stalled = openSync(fifo, "r+")
    const child = Bun.spawn(["bun", CLI, "serve", inventoryApp, "--stdio"], {
      cwd: root,
      stdin: "pipe",
      stdout: stalled,
      stderr: "ignore",
    })
    const inspect = { jsonrpc: "2.0", id: 1, method: "app.inspect", params: { tree: true } }
    const asks = Array.from({ length: 2000 }, () => JSON.stringify(inspect))
    await child.stdin.write(`${asks.join("\n")}\n`)
    await child.stdin.end()
    await child.exited
    closeSync(stalled)
    rmSync(dir, { recursive: true, force: true })
  },
  12_000,
)

test("a session is over stdio or a daemon, not both", () => {
  const result = Bun.spawnSync(["bun", CLI, "serve", inventoryApp, "--stdio", "--daemon"], {
    cwd: root,
    timeout: COMMAND_TIMEOUT_MS,
  })
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain("not both")
})

test("a timeout past the longest allowed is refused", () => {
  const result = Bun.spawnSync(["bun", CLI, "status"], {
    cwd: root,
    env: { ...process.env, REFLEX_START_TIMEOUT_MS: "600001" },
    timeout: COMMAND_TIMEOUT_MS,
  })
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain("REFLEX_START_TIMEOUT_MS")
})

test("a start that times out leaves nothing running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflex-slow-"))
  const pidFile = join(dir, "pid")
  const module = join(dir, "slow.ts")
  await Bun.write(
    module,
    `import { writeFileSync } from "node:fs"
     writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
     await new Promise(() => setInterval(() => {}, 1000))
     export default {}`,
  )
  const result = Bun.spawnSync(["bun", CLI, "start", module], {
    cwd: root,
    env: { ...process.env, REFLEX_DIR: dir, REFLEX_START_TIMEOUT_MS: "1500" },
    timeout: COMMAND_TIMEOUT_MS,
  })
  expect(result.exitCode).toBe(1)
  const pid = Number(await Bun.file(pidFile).text())
  await waitUntil(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, "the daemon to be gone")
  rmSync(dir, { recursive: true, force: true })
}, 15_000)

test(
  "a configured start longer than thirty seconds governs controller startup",
  isolated(async (_, dir) => {
    const module = join(dir, "slow-controller.ts")
    await Bun.write(
      module,
      appModule(`
    // Accelerate only the daemon's timer clock, keeping real spawn/import/ready I/O.
    // The unscaled 31 s reproduction is retained in the scratch output.
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (callback, durationMs, ...args) =>
      realSetTimeout(callback, durationMs / 10, ...args)
    export default { ...inventory, start: async (name, options) => {
      // Forty-five clock seconds: the hidden 30 s deadline fails, 60 s succeeds.
      await new Promise((resolve) => realSetTimeout(resolve, 4500))
      return inventory.start(name, options)
    } }
  `),
    )
    const result = Bun.spawnSync(["bun", CLI, "start", module], {
      cwd: root,
      env: { ...process.env, REFLEX_DIR: dir, REFLEX_START_TIMEOUT_MS: "60000" },
      timeout: 65_000,
    })
    expect(result.exitCode).toBe(0)
  }),
  70_000,
)

test(
  "stdio logging has a byte budget and one truncation notice",
  isolated(async (_, dir) => {
    const module = join(dir, "loud-stdio.ts")
    await Bun.write(
      module,
      appModule(`
    for (let index = 0; index < 3000; index++) console.error("秘密".repeat(512))
    export default inventory
  `),
    )
    const child = Bun.spawn(["bun", CLI, "serve", module, "--stdio"], {
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    await child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.describe" })}\n`,
    )
    await child.stdin.end()
    const exitCode = await child.exited
    const stderr = await errors
    expect(exitCode, stderr.slice(-4096)).toBe(0)
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(1024 * 1024)
    expect(stderr.split("Session log truncated")).toHaveLength(2)
    expect(JSON.parse((await output).trim())).toMatchObject({ id: 1 })
  }),
  15_000,
)

// This fixture needs mkfifo, unavailable on Windows; bounded stdio log tests run on both.
test.skipIf(process.platform === "win32")(
  "a stdio peer that leaves stderr unread cannot block protocol replies",
  isolated(async (_, dir) => {
    const fifo = join(dir, "stderr")
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0)
    const unread = openSync(fifo, "r+")
    const module = join(dir, "unread-logs.ts")
    await Bun.write(
      module,
      appModule(`
    for (let index = 0; index < 3000; index++) console.log("x".repeat(1024))
    export default inventory
  `),
    )
    const child = Bun.spawn(["bun", CLI, "serve", module, "--stdio"], {
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: unread,
    })
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000)
    try {
      const output = new Response(child.stdout).text()
      await child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "app.describe" })}\n`,
      )
      await child.stdin.end()
      expect(await child.exited).toBe(0)
      expect(JSON.parse((await output).trim())).toMatchObject({ id: 1 })
    } finally {
      clearTimeout(watchdog)
      child.kill()
      await child.exited
      closeSync(unread)
    }
  }),
  15_000,
)

/** Taken by binding and releasing it. */
const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port ?? 0
  probe.stop(true)
  return port
}

test(
  "a device bridge runs beside a headless session, each stopped on its own",
  isolated((cli, dir) => {
    const port = freePort()
    const started = cli("--target", "device", "start", "--port", String(port))
    expect(started.code).toBe(0)
    try {
      const token = readFileSync(join(dir, "device.token"), "utf8").trim()
      if (process.platform !== "win32") {
        expect(statSync(join(dir, "device.token")).mode & 0o777).toBe(0o600)
      }
      expect(JSON.parse(started.out)).toEqual({
        target: "device",
        listening: `ws://127.0.0.1:${port}`,
        appSetting: `ws://127.0.0.1:${port}#${token}`,
        androidEmulatorSetting: `ws://10.0.2.2:${port}#${token}`,
        tokenFile: join(dir, "device.token"),
      })
      expect(cli("start", inventoryApp).code).toBe(0)
      expect(cli("--target", "device", "stop").code).toBe(0)
      expect(cli("ls").code).toBe(0)
      // The token outlives the bridge, so a configured app stays configured.
      const again = cli("--target", "device", "start", "--port", String(port))
      expect(JSON.parse(again.out).appSetting).toBe(`ws://127.0.0.1:${port}#${token}`)
    } finally {
      cli("--target", "device", "stop")
    }
  }),
  30_000,
)

test(
  "a device command with no app connected says how to connect one",
  isolated((cli) => {
    const port = freePort()
    expect(cli("--target", "device", "start", "--port", String(port)).code).toBe(0)
    try {
      const result = Bun.spawnSync(["bun", CLI, "--target", "device", "ls"], {
        cwd: root,
        env: { ...process.env, REFLEX_DIR: dirOf(cli) },
        timeout: COMMAND_TIMEOUT_MS,
      })
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain("EXPO_PUBLIC_REFLEX_BRIDGE")
    } finally {
      cli("--target", "device", "stop")
    }
  }),
  30_000,
)

test("device and target arguments are checked before anything starts", () => {
  for (const [args, message] of [
    [["--target", "phone", "ls"], 'must be "headless" or "device"'],
    [["--target"], "--target needs a value"],
    [["--target", "device", "start", "--port", "0"], "--port must be an integer from 1"],
    [["--target", "device", "start", "--port", "70000"], "--port must be an integer"],
    [["--target", "device", "start", inventoryApp], "Unexpected argument"],
  ] as const) {
    const result = reflex(...args)
    expect(result.code).toBe(1)
    expect(result.err).toContain(message)
  }
})

test(
  "a bridge on IPv6 loopback says so, in brackets, and offers no emulator setting",
  isolated(async (cli) => {
    const port = freePort()
    const started = cli("--target", "device", "start", "--host", "::1", "--port", String(port))
    try {
      expect(started.code).toBe(0)
      const description = JSON.parse(started.out)
      expect(description.listening).toBe(`ws://[::1]:${port}`)
      expect(description.appSetting.startsWith(`ws://[::1]:${port}#`)).toBe(true)
      expect(description.androidEmulatorSetting).toBeUndefined()
      const socket = new WebSocket(description.appSetting.split("#")[0])
      const opened = await new Promise<boolean>((resolve) => {
        socket.onopen = () => resolve(true)
        socket.onerror = () => resolve(false)
      })
      socket.close()
      expect(opened).toBe(true)
    } finally {
      cli("--target", "device", "stop")
    }
  }),
  30_000,
)

/** One MCP exchange with `reflex mcp`, as an agent's client would have it. */
const mcpExchange = async (
  extra: ReadonlyArray<string>,
  calls: ReadonlyArray<{ readonly name: string; readonly arguments?: unknown }>,
) => {
  const child = Bun.spawn(["bun", CLI, ...extra, "mcp"], {
    cwd: root,
    env: { ...process.env, REFLEX_DIR: directory },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000)
  try {
    const messages = [
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ...calls.map((params, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/call",
        params,
      })),
    ]
    const output = new Response(child.stdout).text()
    await child.stdin.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(""))
    await child.stdin.end()
    expect(await child.exited).toBe(0)
    const lines = (await output).split("\n").filter((line) => line !== "")
    // Stdout is the protocol's alone: every line a message.
    const replies = lines.map(
      (line) => JSON.parse(line) as { id: number; result: Record<string, unknown> },
    )
    return replies.sort((a, b) => a.id - b.id)
  } finally {
    clearTimeout(watchdog)
    child.kill()
    await child.exited
  }
}

test("reflex mcp drives the same session as the CLI, and answers as it does", async () => {
  const replies = await mcpExchange(
    [],
    [
      {
        name: "reflex_dispatch",
        arguments: { action: "OpenProduct", input: { productId: "product-123" } },
      },
      { name: "reflex_inspect" },
    ],
  )
  expect(replies.map(({ id }) => id)).toEqual([0, 1, 2])
  expect(replies[1]?.result).toMatchObject({ isError: false })
  // The CLI, in its own process, sees what the MCP call did, and says the same of it.
  expect(replies[2]?.result.structuredContent).toEqual(json("ls", "--schema") as never)
  expect(json("ls").name).toBe("InventoryDetail")
})

test("--access observe reads the session but cannot change it", () => {
  const listed = reflex("--access", "observe", "ls")
  expect(listed.code).toBe(0)
  expect(JSON.parse(listed.out).actions).toContainEqual(
    expect.objectContaining({
      name: "OpenProduct",
      unavailable: "Not permitted on this connection",
    }),
  )
  const refused = reflex("--access", "observe", "do", "OpenProduct", '{"productId":"product-123"}')
  expect(refused.code).toBe(1)
  expect(refused.err).toContain("not permitted")
  expect(json("ls").name).toBe("InventoryList")
  expect(reflex("--access", "observe", "reset").code).toBe(1)
  expect(reflex("--access", "observe", "stop").err).toContain("needs full control")
})

test("an action allowlist, from the flag or REFLEX_ACCESS, runs only what it names", () => {
  const opened = Bun.spawnSync(["bun", CLI, "do", "OpenProduct", '{"productId":"product-123"}'], {
    cwd: root,
    env: { ...process.env, REFLEX_DIR: directory, REFLEX_ACCESS: "actions:OpenProduct" },
    timeout: COMMAND_TIMEOUT_MS,
  })
  expect(opened.exitCode).toBe(0)
  const refused = reflex("--access", "actions:OpenProduct", "do", "Increment")
  expect(refused.code).toBe(1)
  expect(json("ls").state).toMatchObject({ quantity: 5 })
  expect(reflex("--access", "actions:", "ls").err).toContain("names 1 to")
  expect(reflex("--access", "everything", "ls").err).toContain("Access must be")
})
