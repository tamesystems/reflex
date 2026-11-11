import { Suspense } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router"
import { developmentBridge } from "@reflex/live/dev"
import { reflex } from "./routes.ts"
import { ListView, DetailView } from "./views.tsx"

const router = createBrowserRouter(
  reflex.routes({
    List: { Component: ListView },
    Detail: {
      Component: DetailView,
      loader: async ({ params }) => ({ id: params.id }),
      errorElement: <p>Could not load detail</p>,
    },
  }),
)
const bridge = developmentBridge()
const root = document.getElementById("root")
if (root === null) {
  throw new Error("Missing root element")
}
createRoot(root).render(
  <reflex.Provider fallback={null} bridge={bridge}>
    <Suspense fallback={<p>Loading…</p>}>
      <RouterProvider router={router} />
    </Suspense>
  </reflex.Provider>,
)
