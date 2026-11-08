// The standalone Hermes VM predates syntax that current Hermes handles
// natively and Expo therefore leaves in place. Lower it for this run.
const fs = require("node:fs")
const babel = require("@babel/core")

const file = process.argv[2]
if (file === undefined) {
  throw new Error("Pass the bundle to lower")
}

const { code } = babel.transformSync(fs.readFileSync(file, "utf8"), {
  babelrc: false,
  configFile: false,
  compact: false,
  sourceType: "script",
  plugins: [
    "@babel/plugin-transform-class-static-block",
    "@babel/plugin-transform-class-properties",
    "@babel/plugin-transform-private-methods",
    "@babel/plugin-transform-private-property-in-object",
    "@babel/plugin-transform-classes",
    "@babel/plugin-transform-async-generator-functions",
    "@babel/plugin-transform-async-to-generator",
  ].map((name) => require.resolve(name)),
})
fs.writeFileSync(file, code)
