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
  return { output: result.stdout, instantiations: Number(count[1]) }
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
const checker = tsc(join(home, "checker.json"))
const examples = tsc(join(home, "examples.json"))
// Check our declaration bodies as well as calls; upstream .d.ts errors are excluded
// by path, never target errors. The normal example project uses skipLibCheck like repo.
const declarations = tsc(join(home, "examples.json"), null, ["--skipLibCheck", "false"])
if (/^docs\/design\/prototypes\/.*error TS/m.test(declarations.output)) {
  throw new Error(declarations.output)
}
const negative = tsc(join(home, "negative.json"), true)
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
const cases = files(join(home, "negative")).flatMap((file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, i) => {
      const m = /@case ([\w-]+) \| (.+)/.exec(line)
      return m ? [{ id: m[1], marker: m[2] ?? "", file, line: i + 2 }] : []
    }),
)
for (const c of cases) {
  const matches = diagnostics.filter((d) => d.file === c.file && d.line === c.line)
  if (!matches.some((d) => d.text.includes(c.marker))) {
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
  if (!row?.includes(`\`${c.marker}\``) || !row.includes(location)) {
    throw new Error(`Misuse table drift for ${c.id}: expected marker and ${location}`)
  }
}
if (new Set(cases.map((c) => c.id)).size !== cases.length) {
  throw new Error("Duplicate negative case ID")
}

const generated = join(home, ".generated")
mkdirSync(generated, { recursive: true })
const measurements: { screens: number; hooks: number; instantiations: number }[] = []
for (const n of [0, 10, 50, 100]) {
  for (const hooks of [0, 1, 10]) {
    let source = `import {Screen,defineApp} from "@reflex/effect"\nimport {createReflex} from "@reflex/react"\nimport * as Schema from "effect/Schema"\n`
    for (let i = 0; i < n; i++) {
      source += `class S${i} extends Screen("S${i}",{state:Schema.Struct({count:Schema.Number}),initial:()=>({count:0})}){declare private readonly nominal:undefined}\nconst I${i}=S${i}.implement({actions:a=>({Add:a.reduce({reducer:(_,s)=>({count:s.count+1})})})})\n`
    }
    source += `const app=defineApp({name:"scale",screens:[${Array.from({ length: n }, (_, i) => `I${i}`).join(",")}]})\nconst reflex=createReflex(app)\n`
    if (n) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < hooks; j++) {
          source += `export function View${i}_${j}(){const v=reflex.useScreen(S${i});if(v.status==="ready"){const count:number=v.state.count;void count;void v.actions.Add.run()}return null}\n`
        }
      }
    }
    const config = join(generated, "tsconfig.json")
    writeFileSync(join(generated, "scale.ts"), source)
    writeFileSync(
      config,
      JSON.stringify({ extends: "../examples.json", include: ["../api/**/*.d.ts", "./scale.ts"] }),
    )
    const measurement = tsc(config)
    measurements.push({ screens: n, hooks, instantiations: measurement.instantiations })
  }
}
const slopes = []
for (const hooks of [0, 1, 10]) {
  for (const [from, to] of [
    [10, 50],
    [50, 100],
  ]) {
    const a = measurements.find((m) => m.screens === from && m.hooks === hooks)
    const b = measurements.find((m) => m.screens === to && m.hooks === hooks)
    if (!a || !b || from === undefined || to === undefined) {
      throw new Error("Missing measurement")
    }
    slopes.push({ hooks, from, to, perScreen: (b.instantiations - a.instantiations) / (to - from) })
  }
}
const maxSlope = Math.max(...slopes.filter((s) => s.hooks === 1).map((s) => s.perScreen))
// Proposed acceptance gate: no more than 2,000 instantiations per added screen
// including its unique useScreen consumer, and 100 for a repeated identical hook.
if (maxSlope > 2000) {
  throw new Error(`Screen slope gate failed: ${maxSlope}`)
}
const repeated = measurements
  .filter((m) => m.hooks === 10 && m.screens > 0)
  .map((m) => {
    const single = measurements.find((s) => s.hooks === 1 && s.screens === m.screens)
    if (!single) {
      throw new Error("Missing single-hook measurement")
    }
    return {
      screens: m.screens,
      perAdditionalHook: (m.instantiations - single.instantiations) / (9 * m.screens),
    }
  })
if (repeated.some((m) => m.perAdditionalHook > 100)) {
  throw new Error(`Repeated hook gate failed: ${JSON.stringify(repeated)}`)
}
const results = {
  typescript: ts.version,
  authoredFiles: authored.length,
  negativeCases: cases.length,
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
writeFileSync(join(home, "results.json"), `${JSON.stringify(results, null, 2)}\n`)
console.log(JSON.stringify(results, null, 2))
