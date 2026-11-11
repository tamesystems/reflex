import { defined, ErrorCode, ProtocolError, type Json, type NodeSnapshot } from "@reflex/protocol"
import type { AppHost, AppSession } from "./controller.ts"
import type { ConsumerDefinition } from "./node-handle.ts"
import { mountSessionRoute } from "./route-mount.ts"
/** Host-owned screens use the same scenario-local factory as their UI route binding. */
export const openSessionRoute = async (
  host: AppHost,
  session: AppSession,
  name: string,
  params: Json,
  signal?: AbortSignal,
): Promise<NodeSnapshot> => {
  const screens = ("screens" in host ? host.screens : {}) as Record<string, ConsumerDefinition>
  const definition = Object.values(screens).find((screen) => screen.name === name)
  if (!definition) {
    throw new ProtocolError(ErrorCode.NodeNotFound, `No screen ${name} in app ${host.name}`)
  }
  let decoded: unknown
  try {
    decoded = definition["~reflex"].decodeParams?.(params) ?? params
  } catch (error) {
    throw new ProtocolError(ErrorCode.InvalidInput, `Invalid params for ${name}: ${String(error)}`)
  }
  const route = await mountSessionRoute(session.runtime, definition, decoded, signal)
  if (signal?.aborted || session.runtime.closed) {
    route.dispose()
    throw new ProtocolError(ErrorCode.SessionClosed, "The route session closed while opening")
  }
  session.runtime.setFocus(route.id)
  return defined(
    session.runtime.inspect({ nodeId: route.id }).node ?? undefined,
    "an opened screen is mounted",
  )
}
