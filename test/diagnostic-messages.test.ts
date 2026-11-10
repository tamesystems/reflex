import { expect, test } from "bun:test"
import { resolve } from "node:path"
import ts from "typescript"

/** Assert the compiler's actual caller-facing text, not just an expected rejection. */
test("action diagnostics explain schema declarations and checked values", () => {
  const root = resolve(import.meta.dirname, "..")
  const file = resolve(root, "test/__diagnostic_probe.ts").replaceAll("\\", "/")
  const source = `
import { defineCapability, defineScreen } from "@reflex/effect"
import { expoRoutes } from "../packages/expo/src/routes-effect.ts"
import * as Schema from "effect/Schema"
import * as Effect from "effect/Effect"
defineCapability({ name: "Diagnostics", state: Schema.Number, actions: action => ({
  Annotated: action({ handler: (value: string) => Effect.succeed(value) }),
  Undeclared: action({ handler: () => Effect.fail({ arbitrary: true }) }),
  Raw: { input: Schema.Number, handler: (value: string) => Effect.succeed(value) },
}) })
const URL = defineScreen({ name: "URL", state: Schema.Number, params: Schema.Struct({ a: Schema.String, b: Schema.String }), initial: () => 0 })
expoRoutes({ screens: { URL } }, {})
expoRoutes({ screens: { URL } }, { URL: { pathname: "/[id]", params: { a: "id", b: "id" } } })
`
  const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile)
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === file
      ? ts.createSourceFile(name, source, languageVersion)
      : read(name, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram([file], { ...options, noErrorTruncation: true }, host)
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === file)
  const messages = diagnostics
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    .join("\n")
  expect(messages).toContain("Annotating the handler input does not declare a schema; add input:")
  expect(messages).toContain("Declare action failures with error:")
  expect(messages).toContain("[CHECKED_ACTION]")
  expect(messages).toContain("URL param mapping targets must be unique")
  expect(messages).toContain("Property 'URL' is missing")
  expect(
    diagnostics
      .slice(0, 2)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
      .join("\n"),
  ).not.toContain("No overload matches this call")
}, 20_000)
