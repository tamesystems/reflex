import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, relative, join } from "node:path"
import { spawnSync } from "node:child_process"
import ts from "typescript"

const root = resolve(import.meta.dir, "../../..")
const home = resolve(import.meta.dir)
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  )
}
function tsc(config: string, expectedFailure: boolean | null = false, extra: string[] = []) {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      config,
      "--pretty",
      "false",
      "--extendedDiagnostics",
      ...extra,
    ],
    { cwd: root, encoding: "utf8" },
  )
  if (result.error) {
    throw result.error
  }
  if (expectedFailure !== null && (result.status === 0) === expectedFailure) {
    throw new Error(`Unexpected compiler status ${result.status}\n${result.stdout}${result.stderr}`)
  }
  const count = /Instantiations:\s+(\d+)/.exec(result.stdout)
  if (!count) {
    throw new Error("Missing instantiation count")
  }
  return {
    output: result.stdout,
    instantiations: Number(count[1]),
    checkSeconds: Number(/Check time:\s+([\d.]+)s/.exec(result.stdout)?.[1] ?? 0),
  }
}
if (ts.version !== "5.9.3") {
  throw new Error(`Expected TypeScript 5.9.3, found ${ts.version}`)
}
const spec = readFileSync(join(home, "../userland-api.md"), "utf8")
const blocks = [...spec.matchAll(/<!-- file: (.+?) -->\n```\w+\n([\s\S]*?)```/g)]
const authored = files(join(home, "examples")).filter((p) => /\.(?:tsx?|js|json)$/.test(p))
for (const file of authored) {
  const path = relative(home, file).replaceAll("\\", "/")
  if (file.endsWith(".json")) {
    JSON.parse(readFileSync(file, "utf8"))
  }
  const block = blocks.find((m) => m[1] === path)
  if (!block || block[2] !== readFileSync(file, "utf8")) {
    throw new Error(`Spec/extracted example drift: ${path}`)
  }
}
if (blocks.length !== authored.length) {
  throw new Error("Spec has an unextracted example")
}
const real = process.argv.includes("--real")
if (real) {
  // The plumbing file also exercises live APIs outside this implementation step.
  // Compile its exact test functions against real packages without substituting declarations.
  const plumbing = ts.createSourceFile(
    "plumbing.ts",
    readFileSync(join(home, "examples/plumbing.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  )
  const testFunctions = plumbing.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) &&
      ["remoteJourney", "pooledJourney"].includes(node.name?.text ?? ""),
  )
  if (testFunctions.length !== 2) {
    throw new Error("Missing compiled test plumbing examples")
  }
  mkdirSync(join(home, ".generated"), { recursive: true })
  writeFileSync(
    join(home, ".generated/test-plumbing.ts"),
    [
      'import { createTestAppPool } from "@reflex/test"',
      'import { createJourneyClient, type JourneyTransport } from "@reflex/test/advanced"',
      'import app from "../examples/examples/plain/src/app.ts"',
      ...testFunctions.map((node) => node.getText(plumbing)),
    ].join("\n"),
  )
  const result = tsc(join(home, "real.json"))
  console.log(
    `Real author, host and test examples: passed (${result.instantiations} instantiations)`,
  )
  if (!process.argv.includes("--performance")) {
    process.exit(0)
  }
}
function checkPublicExamples() {
  const config = ts.readConfigFile(join(home, "examples.json"), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, home)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()
  const used = new Set<ts.Symbol>()
  const canonical = (symbol: ts.Symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node)
      if (symbol) {
        used.add(canonical(symbol))
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const file of program.getSourceFiles()) {
    if (file.fileName.startsWith(join(home, "examples"))) {
      visit(file)
    }
  }
  for (const file of program.getSourceFiles()) {
    if (
      !file.fileName.startsWith(join(home, "api")) ||
      /(?:model|routes)\.d\.ts$/.test(file.fileName)
    ) {
      continue
    }
    const module = checker.getSymbolAtLocation(file)
    if (!module) {
      continue
    }
    for (const item of checker.getExportsOfModule(module)) {
      const symbol = canonical(item)
      if (symbol.flags & ts.SymbolFlags.Value && !used.has(symbol)) {
        throw new Error(
          `Public export has no compiled example: ${relative(home, file.fileName)}:${item.name}`,
        )
      }
    }
  }
}
let checker = { instantiations: 0 }
let examples = { instantiations: 0 }
let negative = { instantiations: 0, output: "" }
let cases: { id: string | undefined; marker: string; file: string; line: number }[] = []
if (!real) {
  checkPublicExamples()
  checker = tsc(join(home, "checker.json"))
  examples = tsc(join(home, "examples.json"))
  // Check our declaration bodies as well as calls; upstream .d.ts errors are excluded
  // by path, never target errors. The normal example project uses skipLibCheck like repo.
  const declarations = tsc(join(home, "examples.json"), null, ["--skipLibCheck", "false"])
  if (/^docs\/design\/prototypes\/.*error TS/m.test(declarations.output)) {
    throw new Error(declarations.output)
  }
  negative = tsc(join(home, "negative.json"), true)
  const diagnostics = [
    ...negative.output.matchAll(
      /^(.+?)\((\d+),(\d+)\): error (TS\d+): ([\s\S]*?)(?=^.+?\(\d+,\d+\): error TS|^Files:|$(?![\s\S]))/gm,
    ),
  ].map((m) => ({
    file: resolve(root, m[1] ?? ""),
    line: Number(m[2]),
    column: Number(m[3]),
    text: m[0],
    used: false,
  }))
  cases = files(join(home, "negative")).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) => {
        const m = /@case ([\w-]+) \| (.+)/.exec(line)
        return m ? [{ id: m[1], marker: m[2] ?? "", file, line: i + 2 }] : []
      }),
  )
  for (const c of cases) {
    const matches = diagnostics.filter((d) => d.file === c.file && d.line === c.line)
    const precise = matches.some((d) => {
      const custom = [...d.text.matchAll(/Msg<([^>]+)>/g)].flatMap((m) =>
        [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((v) => v[1]),
      )
      const sentences = d.text
        .split("\n")
        .map((line) => line.replace(/^.*error TS\d+: /, "").trim())
      return custom.includes(c.marker) || (c.marker.endsWith(".") && sentences.includes(c.marker))
    })
    if (!precise) {
      throw new Error(
        `${c.id}: missing '${c.marker}' at ${relative(root, c.file)}:${c.line}\n${matches.map((d) => d.text).join("\n")}`,
      )
    }
    for (const d of matches) {
      d.used = true
    }
  }
  if (diagnostics.some((d) => !d.used)) {
    throw new Error(
      `Unexpected diagnostics:\n${diagnostics
        .filter((d) => !d.used)
        .map((d) => d.text)
        .join("\n")}`,
    )
  }
  // Marker locations are asserted independently of the table. Keep the table tied to it.
  for (const c of cases) {
    const row = spec.split("\n").find((line) => new RegExp(`\\|\\s+${c.id}\\s+\\|`).test(line))
    const location = `${relative(home, c.file).replaceAll("\\", "/")}#L${c.line}`
    if (!row?.includes(`\`${c.marker.replaceAll("|", "\\|")}\``) || !row.includes(location)) {
      throw new Error(`Misuse table drift for ${c.id}: expected marker and ${location}`)
    }
  }
  if (new Set(cases.map((c) => c.id)).size !== cases.length) {
    throw new Error("Duplicate negative case ID")
  }
}
const generated = join(home, ".generated")
mkdirSync(generated, { recursive: true })
const measurements: {
  screens: number
  hooks: number
  instantiations: number
  checkSeconds: number
}[] = []
for (const n of [0, 100, 200, 400]) {
  for (const hooks of [0, 1, 10]) {
    let source = `import {Screen,defineApp,defineNavigation} from "@reflex/effect"\nimport {createReflexRouter} from "@reflex/react-router"\nimport * as Schema from "effect/Schema"\n`
    for (let i = 0; i < n; i++) {
      source += `class S${i} extends Screen("S${i}",{params:{id:Schema.String},state:Schema.Union([Schema.Struct({_tag:Schema.Literal("loading")}),Schema.Struct({_tag:Schema.Literal("ready"),count:Schema.Number,label:Schema.Literal("label${i}")})]),initial:()=>({_tag:"ready",count:0,label:"label${i}"})}){}\nconst I${i}=S${i}.implement({actions:a=>({Add:a.when("ready").reduce({input:Schema.Struct({by:Schema.NumberFromString}),reducer:(input,s)=>({...s,count:s.count+input.by})})})})\n`
    }
    const defs = Array.from({ length: n }, (_, i) => `I${i}`).join(",")
    const contracts = Array.from({ length: n }, (_, i) => `S${i}`).join(",")
    source += n
      ? `const nav=defineNavigation({${contracts}})\nconst app=defineApp({name:"scale",navigation:nav.implement([${defs}],{initial:{screen:S0,params:{id:"0"}}})})\n`
      : `const app=defineApp({name:"scale"})\n`
    source += `const reflex=createReflexRouter(app,{${Array.from({ length: n }, (_, i) => `S${i}:"/s${i}/:id"`).join(",")}})\n`
    for (let i = 0; i < n && hooks > 0; i++) {
      source += `const feature${i}=reflex.from(I${i})\n`
      for (let j = 0; j < hooks; j++) {
        source += `export function View${i}_${j}(){const v=feature${i}.useScreen();if(v.state._tag==="ready"){const count:number=v.state.count;void count;void v.actions.Add.run({by:"1"})}return null}\n`
      }
    }
    const config = join(generated, "tsconfig.json")
    writeFileSync(join(generated, "scale.ts"), source)
    writeFileSync(
      config,
      JSON.stringify({
        extends: real ? "../real.json" : "../examples.json",
        include: real ? ["./scale.ts"] : ["../api/**/*.d.ts", "./scale.ts"],
      }),
    )
    const measurement = tsc(config)
    measurements.push({
      screens: n,
      hooks,
      instantiations: measurement.instantiations,
      checkSeconds: measurement.checkSeconds,
    })
  }
}
const slopes = []
for (const hooks of [0, 1, 10]) {
  for (const [from, to] of [
    [100, 200],
    [200, 400],
  ] as const) {
    const a = measurements.find((m) => m.screens === from && m.hooks === hooks)
    const b = measurements.find((m) => m.screens === to && m.hooks === hooks)
    if (!a || !b) {
      throw new Error("Missing screen measurement")
    }
    slopes.push({
      hooks,
      from,
      to,
      instantiationsPerScreen: (b.instantiations - a.instantiations) / (to - from),
      msPerScreen: (1000 * (b.checkSeconds - a.checkSeconds)) / (to - from),
    })
  }
}
const repeated = measurements
  .filter((m) => m.hooks === 10)
  .map((m) => {
    const single = measurements.find((s) => s.screens === m.screens && s.hooks === 1)
    if (!single) {
      throw new Error("Missing hook measurement")
    }
    return {
      screens: m.screens,
      msPerAdditionalHook:
        m.screens === 0 ? 0 : (1000 * (m.checkSeconds - single.checkSeconds)) / (9 * m.screens),
    }
  })
// Wall-clock gates intentionally allow scheduler noise. Measurements use heterogeneous
// contracts, codecs, guards, params, navigation, routes and narrowed feature hooks.
const maxSlope = Math.max(...slopes.filter((s) => s.hooks === 1).map((s) => s.msPerScreen))
const results = {
  mode: real ? "real-packages" : "reference-declarations",
  typescript: ts.version,
  authoredFiles: authored.length,
  negativeCases: real
    ? [
        "apps/web/src/api.types.ts",
        "apps/web/src/bindings.types.tsx",
        "apps/mobile/src/expo.types.tsx",
      ].reduce(
        (count, file) =>
          count + [...readFileSync(join(root, file), "utf8").matchAll(/@ts-expect-error/g)].length,
        0,
      )
    : cases.length,
  compiledFiles: authored.filter((file) => !file.endsWith(".json")).length,
  jsonFiles: authored.filter((file) => file.endsWith(".json")).length,
  checker: checker.instantiations,
  examples: examples.instantiations,
  negative: negative.instantiations,
  measurements,
  slopes,
  repeated,
  maxSlope,
}
if (process.env.REFLEX_RECORD_TYPE_PERF === "1") {
  writeFileSync(
    join(home, real ? "real-results.json" : "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  )
}
console.log(JSON.stringify(results, null, 2))

if (maxSlope > 25) {
  throw new Error(`Screen check-time gate failed: ${maxSlope}ms`)
}
if (repeated.some((m) => m.msPerAdditionalHook > 5)) {
  throw new Error(`Hook check-time gate failed: ${JSON.stringify(repeated)}`)
}
