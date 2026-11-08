import { ErrorCode, ProtocolError } from "@reflex/protocol"

/** Size refusals travel through synchronous state writes as defects in Effect. */
export const isLimitReached = (defect: unknown): defect is ProtocolError =>
  defect instanceof ProtocolError && defect.code === ErrorCode.ResourceExhausted
