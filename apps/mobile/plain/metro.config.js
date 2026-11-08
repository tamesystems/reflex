const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")
const parent = require("../metro.config.js")
const config = getDefaultConfig(__dirname)
config.watchFolders = [...parent.watchFolders, path.resolve(__dirname, "..")]
config.resolver = { ...config.resolver, ...parent.resolver }
module.exports = config
