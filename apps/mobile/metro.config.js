const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")

const root = path.resolve(__dirname, "../..")
const config = getDefaultConfig(__dirname)

const original = config.resolver.resolveRequest
const provider = process.env.REFLEX_E2E === "1" ? "e2e/provider.tsx" : "provider.tsx"
/** @type {NonNullable<typeof original>} */
const resolveRequest = (context, name, platform) => {
  if (name === "@reflex/live/dev") {
    return { type: "sourceFile", filePath: path.join(root, "packages/expo/src/dev.ts") }
  }
  if (name === "@inventory-provider") {
    return { type: "sourceFile", filePath: path.join(__dirname, provider) }
  }
  return original == null
    ? context.resolveRequest(context, name, platform)
    : original(context, name, platform)
}
module.exports = {
  ...config,
  watchFolders: [path.join(root, "packages"), path.join(root, "examples")],
  resolver: {
    ...config.resolver,
    disableHierarchicalLookup: true,
    nodeModulesPaths: [path.join(__dirname, "node_modules")],
    resolveRequest,
    extraNodeModules: {
      "@reflex/protocol": path.join(root, "packages/protocol"),
      "@reflex/runtime": path.join(root, "packages/runtime"),
      "@reflex/rpc": path.join(root, "packages/rpc"),
      "@reflex/effect": path.join(root, "packages/effect"),
      "@reflex/live": path.join(root, "packages/live"),
      "@reflex/react": path.join(root, "packages/react"),
      "@reflex/navigation": path.join(root, "packages/navigation"),
      "@reflex/expo": path.join(root, "packages/expo"),
      "@reflex/example-plain": path.join(root, "examples/plain"),
      "@reflex/example-inventory": path.join(root, "examples/inventory"),
    },
  },
}
