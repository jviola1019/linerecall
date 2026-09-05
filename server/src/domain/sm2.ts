import type { CardStateV2, Grade, ReviewEventV1 } from '../contracts.js'

export const DAY_MS = 86_400_000

export interface ScheduledCard {
  cardId: string
  repetitions: number
  intervalDays: number
  easeFactor: number
  dueAt: Date
  lastReviewedAt: Date | null
  lastEventId: string | null
}

export interface StoredReviewEvent extends ReviewEventV1 {
  receivedAt: string
  syncSequence: bigint
  normalizedOccurredAt: string
}

export function newCard(cardId: string, now: Date): ScheduledCard {
  return {
    cardId,
    repetitions: 0,
    intervalDays: 0,
    easeFactor: 2.5,
    dueAt: now,
    lastReviewedAt: null,
    lastEventId: null,
  }
}

export function qualityForGrade(grade: Grade): 0 | 3 | 4 | 5 {
  return { again: 0, hard: 3, good: 4, easy: 5 }[grade] as 0 | 3 | 4 | 5
}

export function scheduleReview(card: ScheduledCard, grade: Grade, reviewedAt: Date, eventId: string): ScheduledCard {
  const quality = qualityForGrade(grade)
  let repetitions = card.repetitions
  let intervalDays = card.intervalDays

  if (quality < 3) {
    repetitions = 0
    intervalDays = 1
  } else {
    intervalDays = repetitions === 0
      ? 1
      : repetitions === 1
        ? 6
        : Math.max(1, Math.round(Math.max(1, intervalDays) * card.easeFactor))
    repetitions += 1
  }

  const nextEase = Math.max(
    1.3,
    card.easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)),
  )

  return {
    ...card,
    repetitions,
    intervalDays,
    easeFactor: Number(nextEase.toFixed(4)),
    dueAt: new Date(reviewedAt.getTime() + intervalDays * DAY_MS),
    lastReviewedAt: reviewedAt,
    lastEventId: eventId,
  }
}

export function masteryForInterval(intervalDays: number, isNew = false): number {
  if (isNew) return 0
  return Math.round(Math.min(100, 100 * Math.log(1 + intervalDays) / Math.log(31)))
}

export function replayCard(cardId: string, events: readonly StoredReviewEvent[], now: Date): ScheduledCard {
  const corrections = new Map<string, StoredReviewEvent>()
  const originals: StoredReviewEvent[] = []
  for (const event of events) {
    if (event.correctsEventId) corrections.set(event.correctsEventId, event)
    else originals.push(event)
  }

  const effective = originals.map((event) => {
    const correction = corrections.get(event.eventId)
    if (!correction) return event
    // A correction changes the grade and audit identity, not when the original
    // review happened. Keeping the original ordering avoids moving a corrected
    // review after a later card attempt.
    return {
      ...event,
      eventId: correction.eventId,
      grade: correction.grade,
      correctsEventId: correction.correctsEventId,
      syncSequence: correction.syncSequence,
    }
  })
  effective.sort((a, b) => {
    const occurred = a.normalizedOccurredAt.localeCompare(b.normalizedOccurredAt)
    if (occurred !== 0) return occurred
    const received = a.receivedAt.localeCompare(b.receivedAt)
    if (received !== 0) return received
    return a.eventId.localeCompare(b.eventId)
  })

  let card = newCard(cardId, now)
  for (const event of effective) {
    card = scheduleReview(card, event.grade, new Date(event.normalizedOccurredAt), event.eventId)
  }
  return card
}

export function serializeCard(card: ScheduledCard, syncSequence: bigint): CardStateV2 {
  return {
    cardId: card.cardId,
    repetitions: card.repetitions,
    intervalDays: card.intervalDays,
    easeFactor: card.easeFactor,
    dueAt: card.dueAt.toISOString(),
    lastReviewedAt: card.lastReviewedAt?.toISOString() ?? null,
    mastery: masteryForInterval(card.intervalDays, card.lastReviewedAt === null),
    lastEventId: card.lastEventId,
    syncSequence: syncSequence.toString(),
  }
}
