/**
 * Every resource a peer can make a session use has its limit here, so that the
 * maximum amount of work it can be asked to do can be read in one place. Exceeding
 * one is an expected condition: the request is refused with `ResourceExhausted`,
 * or the peer is disconnected if it cannot be told. Limits on a single component's
 * private work are named next to it.
 */

// Wire
export const FRAME_CHARACTERS_MAX = 8 * 1024 * 1024
/** Holds at least one full frame, at the three bytes a character can take in UTF-8. */
export const WRITE_QUEUE_BYTES_MAX = 32 * 1024 * 1024
export const JSON_DEPTH_MAX = 64
export const REQUEST_ID_CHARACTERS_MAX = 256
export const BATCH_REQUESTS_MAX = 64
/** A reply this small is never refused for a batch's sake: an acknowledgment must arrive. */
export const SMALL_REPLY_CHARACTERS_MAX = 2048
/** What a batch's larger replies share. The rest of a frame is for the small ones. */
export const BATCH_LARGE_REPLY_CHARACTERS_MAX =
  FRAME_CHARACTERS_MAX - (BATCH_REQUESTS_MAX + 1) * SMALL_REPLY_CHARACTERS_MAX
export const CONNECTION_REQUESTS_MAX = 256
export const CONNECTION_SUBSCRIPTIONS_MAX = 16
export const SERVER_CONNECTIONS_MAX = 32
/** Events held for replies must fit the write queue, at three bytes a character. */
export const HELD_EVENT_CHARACTERS_MAX = WRITE_QUEUE_BYTES_MAX / 3
export const CLIENT_PENDING_REQUESTS_MAX = 256
export const CLIENT_LISTENERS_MAX = 64
export const ERROR_TEXT_CHARACTERS_MAX = 2048
/** Actions one access policy may name, and how long each name may be. */
export const ACCESS_ACTIONS_MAX = 256
export const ACCESS_ACTION_CHARACTERS_MAX = 256

// Live bridge
/** A WebSocket counts bytes, and a frame's characters can take three each. */
export const BRIDGE_FRAME_BYTES_MAX = FRAME_CHARACTERS_MAX * 3
export const BRIDGE_HELLO_CHARACTERS_MAX = 1024
export const BRIDGE_TOKEN_CHARACTERS_MAX = 256
/** Requests that arrived while no app was connected, waiting for one to. */
export const BRIDGE_WAITERS_MAX = 256

// Session
export const SESSION_LOG_BYTES_MAX = 1024 * 1024
/** Kept back so app chatter cannot hide why a session failed. */
export const SESSION_LOG_FAILURE_RESERVE_BYTES = 4096
export const LOG_LINE_CHARACTERS_MAX = 4096
/** A stopped stderr reader must not hold a stdio session open. */
export const SESSION_LOG_DRAIN_TIMEOUT_MS = 1_000
export const NODES_MAX = 1024
/** What one node's state may render to, leaving a frame room for what travels with it. */
export const NODE_STATE_CHARACTERS_MAX = FRAME_CHARACTERS_MAX - 256 * 1024
/** Replies and events wrap a state in a few levels of their own, which must also fit. */
export const NODE_STATE_DEPTH_MAX = JSON_DEPTH_MAX - 8
export const SUBSCRIBERS_MAX = 256
export const NODE_LISTENERS_MAX = 1024
export const WAITS_MAX = 1024
/** Held for as long as a wait lasts, so `WAITS_MAX` of them must stay small together. */
export const WAIT_MATCH_CHARACTERS_MAX = 64 * 1024
export const WAIT_NAME_CHARACTERS_MAX = 256
export const LIFECYCLE_QUEUE_MAX = 8
/** Starts and disposals that outlived their deadlines; each may hold a whole session. */
export const UNFINISHED_SESSIONS_MAX = 4
/** Control requests that outlived their deadline, and may still be running. */
export const OUTSTANDING_CONTROL_REQUESTS_MAX = 16
/**
 * Values in one state, each walked on every change of it. Rows of a few fields reach the
 * size limit first; a state of many tiny values reaches this, and is refused the same way.
 */
export const REDACTION_VISITS_MAX = 1_000_000
/** Bounds Reflect.ownKeys' allocation for indexed native views before scanning. */
export const REDACTION_VIEW_BYTES_MAX = 1_000_000
/** Publishing derives one bounded codec per state, error or route schema. */
export const SCHEMA_NODES_MAX = 10_000
export const SCHEMA_DEPTH_MAX = JSON_DEPTH_MAX
export const RUNNING_OPERATIONS_MAX = 1024
export const RETAINED_OPERATIONS_MAX = 512
/** Beyond this a settled operation keeps its message but not its error data. */
export const RETAINED_ERROR_DATA_CHARACTERS_MAX = 4096
export const RETAINED_EVENTS_MAX = 2048
/** Events for subscriptions whose replies are still crossing the bridge. */
export const BRIDGE_UNROUTED_EVENTS_MAX = RETAINED_EVENTS_MAX
/** Events carry whole states, so a count alone would not bound their memory. */
export const RETAINED_EVENT_CHARACTER_COUNT_MAX = 16 * 1024 * 1024
export const NAVIGATION_STACK_DEPTH_MAX = 64
/**
 * Screens still being built or cleaned up, each holding what it acquired: a deadline can
 * stop waiting for them, not stop them. New screens are refused at this; going back is not.
 */
export const UNFINISHED_SCREEN_WORK_MAX = 8

// Time
export const WAIT_TIMEOUT_MS_DEFAULT = 5_000
export const WAIT_TIMEOUT_MS_MAX = 600_000
export const CLIENT_REQUEST_TIMEOUT_MS_DEFAULT = 30_000
export const SESSION_START_TIMEOUT_MS_DEFAULT = 30_000
export const SESSION_START_TIMEOUT_MS_MAX = 600_000
export const SESSION_DISPOSE_TIMEOUT_MS_DEFAULT = 10_000
/** For requests that run app code with no deadline of their own. */
export const CONTROL_REQUEST_TIMEOUT_MS = 10_000
/** An app that has dialled in must say who it is at once. */
export const BRIDGE_HELLO_TIMEOUT_MS = 5_000
/** Long enough to cover an app reloading, so a command sent meanwhile still lands. */
export const BRIDGE_APP_WAIT_MS = 15_000
export const BRIDGE_REDIAL_DELAY_MS_MIN = 500
export const BRIDGE_REDIAL_DELAY_MS_MAX = 5_000
export const ADVANCE_TIME_MS_MAX = 365 * 24 * 60 * 60 * 1000

/** Text from a failure can be arbitrarily large; only a bounded prefix travels. */
export const boundedText = (text: string): string => {
  if (text.length <= ERROR_TEXT_CHARACTERS_MAX) {
    return text
  }
  return `${text.slice(0, ERROR_TEXT_CHARACTERS_MAX)}…`
}

/** Local pipe mutual authentication, before any JSON-RPC frame is accepted. */
export const LOCAL_AUTH_TIMEOUT_MS = 5_000
export const LOCAL_AUTH_LINE_CHARACTERS_MAX = 256
export const LOCAL_AUTH_SECRET_BYTES = 32

export const LOCAL_AUTH_FRAMES_MAX = 2 ** 32
/** UTF-8 (at most 3 bytes per JS character), then base64, plus a GCM tag. */
export const LOCAL_ENCRYPTED_FRAME_CHARACTERS_MAX = FRAME_CHARACTERS_MAX * 4 + 512

/** Proof-of-read credits also bound Bun's native Windows pipe writer queue. */
export const LOCAL_UNACKNOWLEDGED_FRAMES_MAX = 65_536
export const LOCAL_RECEIPT_BYTES = 16

export const LOCAL_SHUTDOWN_RECEIPT_TIMEOUT_MS = 5_000
