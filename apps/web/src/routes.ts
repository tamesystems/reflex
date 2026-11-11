import { createReflexRouter } from "@reflex/react-router"
import app from "./app.ts"

export const reflex = createReflexRouter(app, { List: "/", Detail: "/detail/:id" })

export const { Provider, useScreen, useScreenStatus, useService, Link, href } = reflex
