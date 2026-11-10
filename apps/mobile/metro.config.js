const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")

const root = path.resolve(__dirname, "../..")
const config = getDefaultConfig(__dirname)

// Workspace sources are compiled directly; there is no build step.
config.watchFolders = [path.join(root, "packages"), path.join(root, "examples")]

// One copy of everything: workspace code must share this app's `effect`.
config.resolver.disableHierarchicalLookup = true
config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules")]
config.resolver.extraNodeModules = {
  "@reflex/protocol": path.join(root, "packages/protocol"),
  "@reflex/runtime": path.join(root, "packages/runtime"),
  "@reflex/rpc": path.join(root, "packages/rpc"),
  "@reflex/effect": path.join(root, "packages/effect"),
  "@reflex/live": path.join(root, "packages/live"),
  "@reflex/react": path.join(root, "packages/react"),
  "@reflex/navigation": path.join(root, "packages/navigation"),
  "@reflex/expo": path.join(root, "packages/expo"),
  "@reflex/example-inventory": path.join(root, "examples/inventory"),
}

module.exports = config
