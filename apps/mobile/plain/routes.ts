import { createReflex } from "@reflex/react"
import { authoredApp as app } from "@reflex/example-plain"
export const reflex = createReflex(app)

export const { Provider, useScreen, useScreenStatus, useService } = reflex
