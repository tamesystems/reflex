import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("real host bindings retain one-step definitions, methods and normalized registration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reflex-host-regression-"))
  const root = resolve(import.meta.dir, "..")
  try {
    const build = await Bun.build({
      entrypoints: [join(root, "docs/design/prototypes/runtime-tests/hosts.tsx")],
      outdir: directory,
      target: "bun",
      packages: "bundle",
      external: ["bun:test"],
      plugins: [
        {
          name: "host-test-platform",
          setup(builder) {
            builder.onResolve(
              { filter: /^(react(?:\/.*)?|react-dom\/server|react-router)$/ },
              (args) => ({
                path: Bun.resolveSync(args.path, join(root, "apps/web")),
              }),
            )
            builder.onResolve({ filter: /^@reflex\/(?:expo|react|react-router)$/ }, (args) => ({
              path: join(root, "packages", args.path.slice("@reflex/".length), "src/index.ts"),
            }))
            builder.onResolve({ filter: /^expo-router$/ }, () => ({
              path: "expo",
              namespace: "host-stub",
            }))
            builder.onResolve({ filter: /^\.\/react\.tsx$/ }, (args) =>
              args.importer.replaceAll("\\", "/").endsWith("/expo/src/bound.tsx")
                ? { path: "plumbing", namespace: "host-stub" }
                : undefined,
            )
            builder.onLoad({ filter: /.*/, namespace: "host-stub" }, () => ({
              contents: `export const Link=()=>null;export const RouterProjection=()=>null;export const routeParam=()=>undefined;export const useLocalSearchParams=()=>({});export const useRoute=()=>({});export const useIsFocused=()=>true`,
              loader: "js",
            }))
          },
        },
      ],
    })
    expect(build.success, build.logs.join("\n")).toBe(true)
    const result = Bun.spawn(
      [process.execPath, "test", build.outputs[0]?.path ?? "missing output"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = await new Response(result.stderr).text()
    expect(await result.exited, output).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
