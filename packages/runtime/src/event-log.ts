import {
  assert,
  defined,
  RETAINED_EVENT_CHARACTER_COUNT_MAX,
  RETAINED_EVENTS_MAX,
  type RuntimeEvent,
} from "@reflex/protocol"

interface Entry {
  readonly event: RuntimeEvent
  readonly characterCount: number
}

/**
 * The events a reconnecting client can still catch up on. Retention is bounded
 * by count and by size, so the oldest are dropped; a client that needs one of
 * those is told to resynchronize instead.
 */
export class EventLog {
  /** Evicted slots are emptied at once: holding one would keep its state alive. */
  private entries: Array<Entry | undefined> = []
  /** Eviction advances this instead of shifting, which would be quadratic. */
  private firstIndex = 0
  private characterCount = 0

  append(event: RuntimeEvent): void {
    const newest = this.entries.at(-1)
    assert(
      newest === undefined || newest.event.sequence < event.sequence,
      "events are appended in sequence order",
    )
    const characterCount = JSON.stringify(event).length
    this.entries.push({ event, characterCount })
    this.characterCount += characterCount
    while (this.isOverBudget()) {
      this.evictOldest()
    }
  }

  /** Events after `sequence`, or null if some of them are gone. */
  after(cursor: {
    readonly sequence: number
    readonly latestSequence: number
  }): ReadonlyArray<RuntimeEvent> | null {
    const { sequence, latestSequence } = cursor
    if (sequence > latestSequence) {
      return null
    }
    if (sequence === latestSequence) {
      return []
    }
    const oldest = this.entries[this.firstIndex]
    if (oldest === undefined || sequence + 1 < oldest.event.sequence) {
      return null
    }
    const events: Array<RuntimeEvent> = []
    for (let index = this.firstIndex; index < this.entries.length; index++) {
      const { event } = defined(this.entries[index], "index is within the retained range")
      if (event.sequence > sequence) {
        events.push(event)
      }
    }
    return events
  }

  private isOverBudget(): boolean {
    if (this.entries.length - this.firstIndex > RETAINED_EVENTS_MAX) {
      return true
    }
    return this.characterCount > RETAINED_EVENT_CHARACTER_COUNT_MAX
  }

  private evictOldest(): void {
    const oldest = defined(this.entries[this.firstIndex], "there is an event to evict")
    this.characterCount -= oldest.characterCount
    assert(this.characterCount >= 0, "evicted events were all counted when appended")
    this.entries[this.firstIndex] = undefined
    this.firstIndex++
    if (this.firstIndex >= RETAINED_EVENTS_MAX || this.firstIndex === this.entries.length) {
      this.entries = this.entries.slice(this.firstIndex)
      this.firstIndex = 0
    }
  }
}
