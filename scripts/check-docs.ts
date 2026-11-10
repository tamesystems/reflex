import { readdir, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import ts from "typescript"

const root = resolve(import.meta.dirname, "..")
const packages = await readdir(resolve(root, "packages"))
const documents = [
  "README.md",
  "docs/adopting.md",
  ...packages.map((name) => `packages/${name}/README.md`),
]
const snippets = new Map<string, string>()
for (const document of documents) {
  const path = resolve(root, document)
  const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return ""
    }
    throw error
  })
  for (const match of source.matchAll(/^```(tsx|typescript|ts)([^\n]*)\n([\s\S]*?)^```/gm)) {
    const modifier = match[2]?.trim() ?? ""
    if (modifier.startsWith("partial:")) {
      if (modifier.length <= "partial:".length) {
        throw new Error(`${document}: partial snippets need a reason`)
      }
      continue
    }
    if (modifier !== "") {
      throw new Error(`${document}: use partial: reason for intentionally incomplete snippets`)
    }
    const line = source.slice(0, match.index).split("\n").length
    const filename = resolve(
      dirname(path),
      `__reflex_doc_line_${line}.${match[1] === "tsx" ? "tsx" : "ts"}`,
    ).replaceAll("\\", "/")
    snippets.set(filename, `${match[3]}\nexport {}\n`)
  }
}
const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile)
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
const compilerOptions: ts.CompilerOptions = {
  ...options,
  jsx: ts.JsxEmit.ReactJSX,
  paths: {
    "@reflex/example-inventory": [resolve(root, "examples/inventory/src/app.ts")],
    "@reflex/example-inventory/*": [resolve(root, "examples/inventory/src/*")],
    react: [resolve(root, "apps/mobile/node_modules/@types/react/index.d.ts")],
    "react/jsx-runtime": [resolve(root, "apps/mobile/node_modules/@types/react/jsx-runtime.d.ts")],
    "expo-router": [resolve(root, "apps/mobile/node_modules/expo-router")],
    "react-router": [resolve(root, "apps/web/node_modules/react-router")],
  },
}
const host = ts.createCompilerHost(compilerOptions)
const read = host.getSourceFile.bind(host)
host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
  const snippet = snippets.get(name)
  return snippet === undefined
    ? read(name, languageVersion, onError, shouldCreateNewSourceFile)
    : ts.createSourceFile(name, snippet, languageVersion)
}
const program = ts.createProgram([...snippets.keys()], compilerOptions, host)
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length > 0) {
  process.stderr.write(
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  )
  process.exit(1)
}
console.log(
  `Typechecked ${snippets.size} complete documentation blocks; partial excerpts are explicitly marked.`,
)
