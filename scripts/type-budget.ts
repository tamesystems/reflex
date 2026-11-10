import { resolve } from "node:path"
import budget from "../docs/performance/type-budget.json"

const root = resolve(import.meta.dirname, "..")
const child = Bun.spawn(
  [
    process.execPath,
    resolve(root, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--extendedDiagnostics",
    "-p",
    resolve(root, "tsconfig.json"),
  ],
  { cwd: root, stdout: "pipe", stderr: "inherit" },
)
const output = await new Response(child.stdout).text()
process.stdout.write(output)
const exit = await child.exited
if (exit !== 0) {
  process.exit(exit)
}
const count = Number(output.match(/^Instantiations:\s+(\d+)/m)?.[1])
if (
  !Number.isSafeInteger(count) ||
  count > Math.floor(budget.instantiations * (1 + budget.margin))
) {
  throw new Error(
    `Type instantiations ${count} exceed budget ${budget.instantiations} + ${budget.margin * 100}%; inspect the graph before updating docs/performance/type-budget.json`,
  )
}
