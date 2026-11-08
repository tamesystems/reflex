// Bare engine, no React Native: drop the modules that expect a native host.
const config = require("../metro.config.js")

config.serializer = {
  ...config.serializer,
  getModulesRunBeforeMainModule: () => [],
  getPolyfills: () => [],
}

module.exports = config
