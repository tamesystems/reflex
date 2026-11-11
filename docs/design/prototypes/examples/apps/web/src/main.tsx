import { developmentBridge } from "@reflex/live/vite"
import { Suspense } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router"
import { Provider, reflex } from "./routes.ts"
import { ListView, DetailView } from "./views.tsx"

const router = createBrowserRouter(
  reflex.routes({
    List: { Component: ListView },
    Detail: {
      Component: DetailView,
      errorElement: <p>Could not load detail</p>,
    },
  }),
)
const root = document.getElementById("root")
if (root === null) {
  throw new Error("Missing root element")
}
createRoot(root).render(
  <Provider fallback={null} bridge={developmentBridge}>
    <Suspense fallback={<p>Loading…</p>}>
      <RouterProvider router={router} />
    </Suspense>
  </Provider>,
)
