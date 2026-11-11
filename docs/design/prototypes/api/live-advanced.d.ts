export interface SessionOwner {
  close(): Promise<void>
}
export declare function createSessionOwner(
  start: () => Promise<{ close(): Promise<void> }>,
): SessionOwner
