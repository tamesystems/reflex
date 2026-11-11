import { createReflex } from "@reflex/react"
import app from "@reflex/example-plain"
export const reflex = createReflex(app)

export const { Provider, useScreen, useScreenStatus, useService, useServiceStatus } = reflex
