import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BoardAnnotationSchema,
  MAX_BOARD_ANNOTATIONS,
  annotationDescription,
  boardAnnotationPoint,
  removeBoardAnnotation,
  toggleBoardAnnotation,
  type BoardAnnotation,
} from '../../src/domain/board-annotations.ts'
import { boardSquares } from '../../src/domain/board.ts'

test('annotation coordinates follow board orientation exactly', () => {
  assert.deepEqual(boardAnnotationPoint('a8', 'white'), { x: 6.25, y: 6.25 })
  assert.deepEqual(boardAnnotationPoint('a8', 'black'), { x: 93.75, y: 93.75 })
  assert.deepEqual(boardAnnotationPoint('h1', 'white'), { x: 93.75, y: 93.75 })
  assert.deepEqual(boardAnnotationPoint('h1', 'black'), { x: 6.25, y: 6.25 })
  assert.throws(() => boardAnnotationPoint('z9' as never, 'white'))
})
test('toggle removes an exact annotation and retags matching geometry', () => {
  const study = { kind: 'arrow', from: 'e2', to: 'e4', tone: 'study' } as const
  const added = toggleBoardAnnotation([], study)
  assert.equal(added.change, 'added')
  assert.equal(annotationDescription(added.annotations[0]!), 'Study arrow from e2 to e4')

  const retagged = toggleBoardAnnotation(added.annotations, { ...study, tone: 'warning' })
  assert.equal(retagged.change, 'retagged')
  assert.equal(retagged.annotations[0]?.tone, 'warning')

  const removed = toggleBoardAnnotation(retagged.annotations, { ...study, tone: 'warning' })
  assert.equal(removed.change, 'removed')
  assert.deepEqual(removed.annotations, [])
})

test('annotation schema rejects invalid squares and zero-length arrows', () => {
  assert.equal(BoardAnnotationSchema.safeParse({ kind: 'circle', square: 'i9', tone: 'study' }).success, false)
  const sameSquare = BoardAnnotationSchema.safeParse({ kind: 'arrow', from: 'd4', to: 'd4', tone: 'study' })
  assert.equal(sameSquare.success, false)
  if (!sameSquare.success) assert.match(sameSquare.error.issues[0]?.message ?? '', /different squares/u)
})

test('personal annotations are bounded to 32 and remain removable', () => {
  const annotations: BoardAnnotation[] = boardSquares('white').slice(0, MAX_BOARD_ANNOTATIONS).map((square) => ({
    kind: 'circle',
    square,
    tone: 'alternative',
  }))
  assert.throws(
    () => toggleBoardAnnotation(annotations, { kind: 'circle', square: boardSquares('white')[32]!, tone: 'study' }),
    /at most 32 annotations/u,
  )
  const next = removeBoardAnnotation(annotations, annotations[0]!)
  assert.equal(next.length, MAX_BOARD_ANNOTATIONS - 1)
})
