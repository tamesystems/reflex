export interface SessionOwner {
  close(): Promise<void>
}
/** Closing during startup still waits for and closes the resulting session. */
export function createSessionOwner(start: () => Promise<SessionOwner>): SessionOwner {
  const session = Promise.resolve().then(start)
  void session.catch(() => {})
  let closing: Promise<void> | undefined
  return { close: () => (closing ??= session.then((owner) => owner.close())) }
}
