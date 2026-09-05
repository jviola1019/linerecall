import { z } from 'zod'

const FamilyIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/u)

export type AppHashRoute =
  | { view: 'today' }
  | { view: 'repertoire' }
  | { view: 'family'; familyId: string }
  | { view: 'train'; familyId: string; side: 'white' | 'black' }
  | { view: 'puzzles' }
  | { view: 'explore' }
  | { view: 'progress' }
  | { view: 'data' }

const STATIC_ROUTES = new Set(['today', 'repertoire', 'puzzles', 'explore', 'progress', 'data'])

function safeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function parseAppHash(hash: string): AppHashRoute {
  const path = hash.replace(/^#\/?/u, '').split(/[?#]/u, 1)[0] ?? ''
  const segments = path.split('/').filter(Boolean)
  if (segments.length === 0) return { view: 'today' }

  const [first, second, third] = segments
  if (segments.length === 1 && first && STATIC_ROUTES.has(first)) {
    return { view: first as Exclude<AppHashRoute['view'], 'family' | 'train'> }
  }

  if (first === 'repertoire' && segments.length === 2 && second) {
    const familyId = safeSegment(second)
    if (familyId && FamilyIdSchema.safeParse(familyId).success) return { view: 'family', familyId }
  }

  if (
    first === 'train'
    && segments.length === 3
    && second
    && (third === 'white' || third === 'black')
  ) {
    const familyId = safeSegment(second)
    if (familyId && FamilyIdSchema.safeParse(familyId).success) {
      return { view: 'train', familyId, side: third }
    }
  }

  return { view: 'today' }
}

export function appHashForRoute(route: AppHashRoute): string {
  if (route.view === 'family') return `#/repertoire/${route.familyId}`
  if (route.view === 'train') return `#/train/${route.familyId}/${route.side}`
  return `#/${route.view}`
}

export function navViewForRoute(route: AppHashRoute): 'today' | 'repertoire' | 'puzzles' | 'explore' | 'progress' | 'data' {
  if (route.view === 'family' || route.view === 'train') return 'repertoire'
  return route.view
}
