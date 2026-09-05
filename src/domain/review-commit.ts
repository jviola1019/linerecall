import type { ReviewGrade } from './progress.ts'

/**
 * Minimal append-only review metadata shared by the local trainer and the
 * connected sync boundary. Keeping this contract in the domain prevents the
 * application shell from depending on a particular training screen.
 */
export interface ReviewCommitMetadata {
  kind: 'review' | 'correction'
  grade: ReviewGrade
  lineId: string
  nodeId: string
  occurredAt: string
  correctsEventId?: string
}
