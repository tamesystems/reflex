import { resolve } from "node:path"
import { defineConfig } from "vite"

export default defineConfig({
  build: { sourcemap: true },
  resolve: {
    alias: {
      "@reflex/react-router": resolve(
        import.meta.dirname,
        "../../packages/react-router/src/index.ts",
      ),
      "@reflex/react/advanced": resolve(
        import.meta.dirname,
        "../../packages/react/src/advanced.ts",
      ),
      "@reflex/react": resolve(import.meta.dirname, "../../packages/react/src/index.ts"),
      "@reflex/live/dev": resolve(import.meta.dirname, "../../packages/live/src/vite.ts"),
      "@reflex/live/vite": resolve(import.meta.dirname, "../../packages/live/src/vite.ts"),
      "@reflex/live/session": resolve(import.meta.dirname, "../../packages/live/src/session.ts"),
      "@reflex/live": resolve(import.meta.dirname, "../../packages/live/src/index.ts"),
      "@reflex/protocol": resolve(import.meta.dirname, "../../packages/protocol/src/index.ts"),
      "@reflex/runtime/internal": resolve(
        import.meta.dirname,
        "../../packages/runtime/src/internal.ts",
      ),
      "@reflex/runtime": resolve(import.meta.dirname, "../../packages/runtime/src/index.ts"),
      "@reflex/rpc/connection": resolve(import.meta.dirname, "../../packages/rpc/src/server.ts"),
    },
    dedupe: ["react", "react-dom", "react-router"],
  },
})
