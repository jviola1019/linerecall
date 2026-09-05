// @vitest-environment jsdom

import { webcrypto } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { GraphTrainingBoundary } from '../../src/app/components/GraphTrainingBoundary.tsx'
import {
  MemoryFamilyTrainingJournalRepository,
  type FamilyTrainingJournalRepository,
} from '../../src/domain/family-training-journal.ts'
import {
  GRAPH_TRAINING_CONTRACT_ID,
  type GraphTrainingPathCompletionV1,
  type GraphTrainingReviewInference,
} from '../../src/domain/graph-training-session.ts'
import { stableRepertoireCardId, type RepertoireGraphDocument } from '../../src/domain/repertoire.ts'
import { createSyntheticTranspositionGraph } from '../fixtures/synthetic-repertoire-graph.ts'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true })

let graph: RepertoireGraphDocument

beforeAll(async () => {
  graph = await createSyntheticTranspositionGraph()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('validated v3 graph-training boundary', () => {
  test('keeps disabled, loading, external-error, and corrupt graph states visible', async () => {
    const { rerender } = render(
      <GraphTrainingBoundary
        resource={{ status: 'disabled', reason: 'No audited v3 pack has been promoted.' }}
        dueCardIds={[]}
        orientation="white"
      />,
    )
    expect(screen.getByRole('heading', { name: 'Guided practice is not ready' })).toBeVisible()
    expect(screen.getByText('No audited v3 pack has been promoted.')).toBeVisible()

    rerender(<GraphTrainingBoundary resource={{ status: 'loading' }} dueCardIds={[]} orientation="white" />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading opening practice')

    rerender(<GraphTrainingBoundary resource={{ status: 'error', error: 'Graph shard is offline.' }} dueCardIds={[]} orientation="white" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Graph shard is offline.')

    rerender(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph: { schemaVersion: 1 } } }}
        dueCardIds={[]}
        orientation="white"
      />,
    )
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Opening practice could not be loaded' })).toBeVisible())
  })

  test('pages and filters every named variation without rendering an unbounded selector', async () => {
    const user = userEvent.setup()
    const pathId = graph.paths[0]!.id
    const pathGroups = Array.from({ length: 75 }, (_, index) => ({
      id: `branch-${String(index + 1).padStart(2, '0')}`,
      label: `Variation ${String(index + 1).padStart(2, '0')}`,
      pathIds: [pathId],
    }))
    render(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } }}
        dueCardIds={[]}
        orientation="white"
        pathGroups={pathGroups}
      />,
    )

    const chooser = await screen.findByRole('list', { name: 'Named variations' })
    expect(within(chooser).getAllByRole('button')).toHaveLength(50)
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(within(chooser).getAllByRole('button')).toHaveLength(25)
    await user.type(screen.getByRole('searchbox', { name: 'Find a named variation' }), 'Variation 75')
    expect(within(chooser).getAllByRole('button')).toHaveLength(1)
    expect(within(chooser).getByRole('button', { name: /Variation 75/u })).toBeVisible()
  })

  test('lists every audited path and follows an alternate branch without a grade confirmation', async () => {
    const user = userEvent.setup()
    const memory = new MemoryFamilyTrainingJournalRepository()
    const writeOrder: string[] = []
    const repository: FamilyTrainingJournalRepository = {
      kind: 'memory',
      appendCoverageEvent: (event) => memory.appendCoverageEvent(event),
      appendCycleEvent: (event) => memory.appendCycleEvent(event),
      appendCursor: async (cursor) => {
        writeOrder.push('cursor')
        return memory.appendCursor(cursor)
      },
      listCoverageEvents: (scope) => memory.listCoverageEvents(scope),
      listCycleEvents: (scope) => memory.listCycleEvents(scope),
      loadLatestCursor: (scope) => memory.loadLatestCursor(scope),
      loadCursor: (scope) => memory.loadCursor(scope),
    }
    const reviews = vi.fn((_review: GraphTrainingReviewInference) => { writeOrder.push('review') })
    const announcements = vi.fn()
    render(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } }}
        dueCardIds={[stableRepertoireCardId(graph.pack.id, graph.pack.rootNodeId)]}
        orientation="white"
        reducedMotion
        onInferredReview={reviews}
        onAnnouncement={announcements}
        familyId="synthetic-family"
        journalRepository={repository}
      />,
    )

    const pathList = await screen.findByRole('list', { name: 'Variation paths' })
    const options = within(pathList).getAllByRole('button')
    expect(options).toHaveLength(graph.paths.length)
    expect(options.some((option) => option.textContent?.includes('Knight first'))).toBe(true)
    expect(options.some((option) => option.textContent?.includes('Fianchetto first'))).toBe(true)

    const knight = options.find((option) => option.textContent?.includes('Knight first'))!
    await user.click(knight)
    await user.click(screen.getByRole('button', { name: 'Practice selected line' }))
    await waitFor(async () => expect(await memory.loadLatestCursor({
      releaseId: graph.releaseId,
      familyId: 'synthetic-family',
      packId: graph.pack.id,
      side: graph.pack.side,
    })).not.toBeNull())
    writeOrder.length = 0
    expect(screen.getByRole('heading', { name: 'Opening practice' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Again$|^Hard$|^Good$|^Easy$/u })).not.toBeInTheDocument()
    expect(screen.getByRole('tabpanel', { name: 'line analysis' })).toHaveTextContent(/Current continuation/u)
    await user.click(screen.getByRole('tab', { name: 'Alternatives' }))
    expect(screen.getByRole('tabpanel', { name: 'alternatives analysis' })).toHaveTextContent(/Known moves from this position/u)
    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    expect(screen.getByRole('tabpanel', { name: 'evidence analysis' })).toHaveTextContent(/historical play/u)
    expect(screen.queryByRole('table')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Reveal evidence' }))
    expect(screen.getByRole('table')).toBeVisible()
    expect(screen.getByRole('table')).toHaveTextContent('W / D / L')
    expect(screen.getByText(/Engine forecasts/u)).toBeVisible()

    const evidenceTab = screen.getByRole('tab', { name: 'Evidence' })
    evidenceTab.focus()
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'Alternatives' })).toHaveFocus()
    expect(screen.getByRole('tabpanel', { name: 'alternatives analysis' })).toBeVisible()
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Line' })).toHaveFocus()
    writeOrder.length = 0

    const picker = screen.getByRole('combobox', { name: 'Legal move picker' })
    await user.selectOptions(picker, 'g2g3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))

    expect(reviews).toHaveBeenCalledTimes(1)
    expect(reviews.mock.calls[0]?.[0]).toMatchObject({ grade: 'again', source: 'due', moveUci: 'g2g3' })
    await waitFor(() => expect(writeOrder).toContain('cursor'))
    expect(writeOrder[0]).toBe('review')
    expect(announcements).toHaveBeenCalledWith('Known alternate line accepted. Continuing from the resulting position.')
    expect(document.querySelector('[data-square="g3"][data-piece-type="wp"]')).not.toBeNull()
    await waitFor(() => expect(screen.getByText(/1 of 3 moves played ·/u)).toBeVisible())
  })

  test.each([
    { button: 'Show hint', grade: 'hard' },
    { button: 'Reveal line', grade: 'again' },
  ])('full opening mode includes every path and $button infers $grade for a due position', async ({ button, grade }) => {
    const user = userEvent.setup()
    const reviews = vi.fn()
    render(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } }}
        dueCardIds={[stableRepertoireCardId(graph.pack.id, graph.pack.rootNodeId)]}
        orientation="white"
        reducedMotion
        onInferredReview={reviews}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Start full opening' }))
    expect(screen.getByRole('progressbar', { name: /variations completed/u })).toBeVisible()
    const remaining = screen.getByText('Remaining').closest('div')
    expect(remaining).not.toBeNull()
    expect(within(remaining!).getByText(String(graph.paths.length))).toBeVisible()
    expect(screen.getByText(/Variation 1 of 2/u)).toBeVisible()
    await user.click(screen.getByRole('button', { name: button }))
    const picker = screen.getByRole('combobox', { name: 'Legal move picker' })
    await user.selectOptions(picker, 'g1f3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    expect(reviews.mock.calls[0]?.[0]).toMatchObject({ grade, source: 'due' })
  })

  test('provides a mobile-equivalent training toolbar and pauses moves during keyboard annotations', async () => {
    const user = userEvent.setup()
    const announcements = vi.fn()
    render(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } }}
        dueCardIds={[]}
        orientation="white"
        reducedMotion
        onAnnouncement={announcements}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Start full opening' }))
    const tools = screen.getByRole('toolbar', { name: 'Training tools' })
    expect(within(tools).getAllByRole('button')).toHaveLength(4)

    await user.click(within(tools).getByRole('button', { name: 'Lines' }))
    expect(screen.getByRole('tabpanel', { name: 'alternatives analysis' })).toBeVisible()
    expect(screen.getByRole('complementary', { name: /Knight first/u })).toHaveFocus()

    await user.click(within(tools).getByRole('button', { name: 'Why' }))
    expect(screen.getByRole('tabpanel', { name: 'evidence analysis' })).toBeVisible()

    await user.click(within(tools).getByRole('button', { name: 'Annotate' }))
    expect(screen.getByRole('heading', { name: 'Board annotations' })).toBeVisible()
    expect(screen.getByRole('group', { name: 'Non-spatial annotation controls' })).toBeVisible()
    expect(screen.getByRole('gridcell', { name: /^g1,/u })).toHaveAttribute('aria-disabled', 'true')
    expect(announcements).toHaveBeenCalledWith('Annotate mode on. Moves are paused.')

    await user.click(within(tools).getByRole('button', { name: 'Resume' }))
    expect(screen.queryByRole('heading', { name: 'Board annotations' })).not.toBeInTheDocument()
    expect(screen.getByRole('gridcell', { name: /^g1,/u })).not.toHaveAttribute('aria-disabled')
  })

  test('pause, choose-variation, and stop controls preserve an explicit user exit path', async () => {
    const user = userEvent.setup()
    const onStop = vi.fn()
    render(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } }}
        dueCardIds={[]}
        orientation="white"
        reducedMotion
        onStop={onStop}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Start full opening' }))
    const desktopControls = document.querySelector('.desktop-session-controls')
    if (!(desktopControls instanceof HTMLElement)) throw new Error('Desktop session controls are missing')
    const pause = within(desktopControls).getByRole('button', { name: 'Pause' })
    await user.click(pause)
    expect(within(desktopControls).getByRole('button', { name: 'Resume' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(within(desktopControls).getByRole('button', { name: 'Choose variation' }))
    expect(await screen.findByRole('heading', { name: 'Practice this opening' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Start full opening' }))
    const restartedDesktopControls = document.querySelector('.desktop-session-controls')
    if (!(restartedDesktopControls instanceof HTMLElement)) throw new Error('Restarted desktop session controls are missing')
    await user.click(within(restartedDesktopControls).getByRole('button', { name: 'Stop training' }))
    await waitFor(() => expect(onStop).toHaveBeenCalledTimes(1))
  })

  test('continues autonomously through every branch and emits one versioned completion per path', async () => {
    const user = userEvent.setup()
    const completions = vi.fn()
    render(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } }}
        dueCardIds={[]}
        orientation="white"
        reducedMotion
        onPathCompleted={completions}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Start full opening' }))

    const play = async (uci: string): Promise<void> => {
      const picker = await screen.findByRole('combobox', { name: 'Legal move picker' })
      await waitFor(() => expect(picker).toBeEnabled())
      await user.selectOptions(picker, uci)
      await user.click(screen.getByRole('button', { name: 'Play move' }))
    }

    await play('g1f3')
    await waitFor(() => expect(screen.getByText(/1 of 3 moves played ·/u)).toBeVisible())
    await play('g2g3')
    await waitFor(() => expect(screen.getByText(/2 of 3 moves played ·/u)).toBeVisible())
    await play('f1g2')
    await waitFor(() => expect(screen.getByText(/Variation 2 of 2/u)).toBeVisible())

    const completed = screen.getByText('Practiced').closest('div')
    expect(completed).not.toBeNull()
    expect(within(completed!).getByText('1')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Fianchetto first' })).toBeVisible()

    await play('g2g3')
    await waitFor(() => expect(screen.getByText(/1 of 3 moves played ·/u)).toBeVisible())
    await play('g1f3')
    await waitFor(() => expect(screen.getByText(/2 of 3 moves played ·/u)).toBeVisible())
    await play('f1g2')

    expect(await screen.findByRole('heading', { name: 'Every selected variation is complete.' })).toBeVisible()
    await waitFor(() => expect(completions).toHaveBeenCalledTimes(2))
    expect(new Set(completions.mock.calls.map(([completion]) => completion.pathId)).size).toBe(2)
    expect(completions.mock.calls[0]?.[0]).toMatchObject({
      contractId: 'linerecall.graph-path-completion.v1',
      schemaVersion: 1,
      releaseId: graph.releaseId,
      packId: graph.pack.id,
    })

    await user.click(screen.getByRole('button', { name: 'Start a new practice round' }))
    await play('g1f3')
    await waitFor(() => expect(screen.getByText(/1 of 3 moves played ·/u)).toBeVisible())
    await play('g2g3')
    await waitFor(() => expect(screen.getByText(/2 of 3 moves played ·/u)).toBeVisible())
    await play('f1g2')
    await waitFor(() => expect(completions).toHaveBeenCalledTimes(3))
    expect(completions.mock.calls[2]?.[0].coverageCycleId).toMatch(/::coverage:1$/u)
  }, 30_000)

  test('records a completed variation before automatically opening a different unfinished variation', async () => {
    const user = userEvent.setup()
    let saveCompletion!: () => void
    const completionSaved = new Promise<void>((resolve) => { saveCompletion = resolve })
    const repository = new MemoryFamilyTrainingJournalRepository()
    const onPathCompleted = vi.fn(async (completion: GraphTrainingPathCompletionV1) => {
      await completionSaved
      await repository.appendCoverageEvent({
        schemaVersion: 1, eventId: crypto.randomUUID(), familyId: 'synthetic-family',
        releaseId: completion.releaseId, packId: completion.packId, pathId: completion.pathId,
        coverageCycleId: completion.coverageCycleId, completedAt: completion.completedAt,
      })
    })
    const props = {
      resource: { status: 'ready' as const, envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } },
      dueCardIds: [], orientation: 'white' as const, reducedMotion: true,
      familyId: 'synthetic-family', journalRepository: repository, onPathCompleted,
    }
    const scope = { releaseId: graph.releaseId, familyId: 'synthetic-family', packId: graph.pack.id, side: graph.pack.side }
    const first = render(<GraphTrainingBoundary {...props} />)
    await user.click(await screen.findByRole('button', { name: 'Start full opening' }))
    await waitFor(async () => expect(await repository.loadLatestCursor(scope)).not.toBeNull())
    const beforeCompletion = (await repository.loadLatestCursor(scope))!

    const play = async (uci: string): Promise<void> => {
      const picker = await screen.findByRole('combobox', { name: 'Legal move picker' })
      await waitFor(() => expect(picker).toBeEnabled())
      await user.selectOptions(picker, uci)
      await user.click(screen.getByRole('button', { name: 'Play move' }))
    }
    await play('g1f3')
    await play('g2g3')
    await play('f1g2')

    await waitFor(() => expect(onPathCompleted).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('heading', { name: 'Knight first' })).toBeVisible()
    expect(screen.getByText(/Variation 1 of 2/u)).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.queryByRole('heading', { name: 'Fianchetto first' })).not.toBeInTheDocument()
    expect((await repository.loadLatestCursor(scope))?.completedPathIds).toHaveLength(0)
    expect(await repository.listCoverageEvents(scope)).toHaveLength(0)

    saveCompletion()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Fianchetto first' })).toBeVisible())
    expect(screen.getByText(/Variation 2 of 2/u)).toBeVisible()
    expect(screen.getByRole('progressbar', { name: '1 of 2 variations completed' })).toBeVisible()
    await waitFor(async () => expect((await repository.loadLatestCursor(scope))?.completedPathIds).toHaveLength(1))
    first.unmount()
    // Simulate a crash after the event commit but before the latest cursor
    // reached durable storage. Restoration must replay the event, not the line.
    await repository.appendCursor(beforeCompletion)
    render(<GraphTrainingBoundary {...props} />)
    expect(await screen.findByRole('heading', { name: 'Fianchetto first' })).toBeVisible()
    expect(screen.getByRole('progressbar', { name: '1 of 2 variations completed' })).toBeVisible()
    expect(onPathCompleted).toHaveBeenCalledTimes(1)
  }, 30_000)

  test('keeps the finished variation open after a completion write fails and retries without double-counting', async () => {
    const user = userEvent.setup()
    const onPathCompleted = vi.fn()
      .mockRejectedValueOnce(new Error('Synthetic completion outage'))
      .mockResolvedValue(undefined)
    render(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } }}
        dueCardIds={[]}
        orientation="white"
        reducedMotion
        onPathCompleted={onPathCompleted}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Start full opening' }))
    const play = async (uci: string): Promise<void> => {
      const picker = await screen.findByRole('combobox', { name: 'Legal move picker' })
      await waitFor(() => expect(picker).toBeEnabled())
      await user.selectOptions(picker, uci)
      await user.click(screen.getByRole('button', { name: 'Play move' }))
    }
    await play('g1f3')
    await play('g2g3')
    await play('f1g2')

    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic completion outage')
    expect(screen.getByRole('heading', { name: 'Knight first' })).toBeVisible()
    expect(screen.getByText(/Variation 1 of 2/u)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Retry this variation' }))

    await waitFor(() => expect(onPathCompleted).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('heading', { name: 'Fianchetto first' })).toBeVisible()
    expect(screen.getByText(/Variation 2 of 2/u)).toBeVisible()
    expect(screen.getByRole('progressbar', { name: '1 of 2 variations completed' })).toBeVisible()
  }, 30_000)

  test('manual pacing pauses opponent and path-boundary transitions without changing inferred scheduling', async () => {
    const user = userEvent.setup()
    const reviews = vi.fn()
    render(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } }}
        dueCardIds={[stableRepertoireCardId(graph.pack.id, graph.pack.rootNodeId)]}
        orientation="white"
        reducedMotion
        manualPacing
        onInferredReview={reviews}
      />,
    )
    const pathList = await screen.findByRole('list', { name: 'Variation paths' })
    const knightPath = within(pathList).getAllByRole('button')
      .find((button) => button.textContent?.includes('Knight first'))
    if (!knightPath) throw new Error('Knight-first regression path is missing')
    await user.click(knightPath)
    await user.click(await screen.findByRole('button', { name: 'Practice selected line' }))
    const picker = screen.getByRole('combobox', { name: 'Legal move picker' })
    await user.selectOptions(picker, 'g1f3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))

    expect(reviews).not.toHaveBeenCalled()
    const grading = screen.getByRole('group', { name: 'Choose recall grade' })
    await user.click(within(grading).getByRole('button', { name: /Good/u }))
    expect(reviews).toHaveBeenCalledWith(expect.objectContaining({ grade: 'good', source: 'due' }))
    const opponent = screen.getByRole('button', { name: 'Play opponent reply' })
    expect(opponent).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(opponent).toBeVisible()
    await user.click(opponent)
    await waitFor(() => expect(screen.getByText(/1 of 3 moves played ·/u)).toBeVisible())

    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'g2g3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    await user.click(screen.getByRole('button', { name: 'Play opponent reply' }))
    await waitFor(() => expect(screen.getByText(/2 of 3 moves played ·/u)).toBeVisible())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'f1g2')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    const boundary = screen.getByRole('button', { name: 'Continue to next variation' })
    expect(boundary).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(boundary).toBeVisible()
  }, 30_000)

  test('keeps future line and evidence hidden while manual opponent reply is pending', async () => {
    const user = userEvent.setup()
    render(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } }}
        dueCardIds={[]}
        orientation="white"
        reducedMotion
        manualPacing
      />,
    )
    const pathList = await screen.findByRole('list', { name: 'Variation paths' })
    const knightPath = within(pathList).getAllByRole('button')
      .find((button) => button.textContent?.includes('Knight first'))
    if (!knightPath) throw new Error('Knight-first regression path is missing')
    await user.click(knightPath)
    await user.click(await screen.findByRole('button', { name: 'Practice selected line' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'g1f3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))

    const line = screen.getByRole('tabpanel', { name: 'line analysis' })
    expect(line).toHaveTextContent('The next moves stay hidden during recall.')
    expect(within(line).getByRole('button', { name: 'Reveal line' })).toBeDisabled()
    expect(line).not.toHaveTextContent('d5')

    await user.click(screen.getByRole('tab', { name: 'Alternatives' }))
    const alternatives = screen.getByRole('tabpanel', { name: 'alternatives analysis' })
    expect(alternatives).toHaveTextContent('Alternatives stay hidden until you request help.')
    expect(within(alternatives).getByRole('button', { name: 'Reveal moves' })).toBeDisabled()
    expect(alternatives).not.toHaveTextContent('d5')

    await user.click(screen.getByRole('tab', { name: 'Evidence' }))
    const evidence = screen.getByRole('tabpanel', { name: 'evidence analysis' })
    expect(evidence).toHaveTextContent('Move evidence stays hidden until you reveal this position.')
    expect(within(evidence).getByRole('button', { name: 'Reveal evidence' })).toBeDisabled()
    expect(evidence).not.toHaveTextContent('d5')
    expect(screen.getByRole('button', { name: 'Play opponent reply' })).toBeVisible()
  })

  test('restores authoritative completion and pending paths from an explicit journal repository after remount', async () => {
    const user = userEvent.setup()
    const repository = new MemoryFamilyTrainingJournalRepository()
    const props = {
      resource: { status: 'ready' as const, envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } },
      dueCardIds: [] as const,
      orientation: 'white' as const,
      reducedMotion: true,
      manualPacing: true,
      familyId: 'synthetic-family',
      journalRepository: repository,
    }
    const first = render(<GraphTrainingBoundary {...props} />)
    await user.click(await screen.findByRole('button', { name: 'Start full opening' }))

    const play = async (uci: string): Promise<void> => {
      const picker = await screen.findByRole('combobox', { name: 'Legal move picker' })
      await user.selectOptions(picker, uci)
      await user.click(screen.getByRole('button', { name: 'Play move' }))
    }
    await play('g1f3')
    await user.click(screen.getByRole('button', { name: 'Play opponent reply' }))
    await play('g2g3')
    await user.click(screen.getByRole('button', { name: 'Play opponent reply' }))
    await play('f1g2')

    await waitFor(async () => {
      const saved = await repository.loadLatestCursor({
        releaseId: graph.releaseId,
        familyId: 'synthetic-family',
        packId: graph.pack.id,
        side: graph.pack.side,
      })
      expect(saved?.completedPathIds).toHaveLength(1)
      expect(saved?.pendingPathIds).toHaveLength(1)
      expect(saved?.batchIndex).toBe(0)
    })
    first.unmount()

    render(<GraphTrainingBoundary {...props} />)
    expect(await screen.findByRole('heading', { name: 'Opening practice' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Fianchetto first' })).toBeVisible()
    expect(within(screen.getByText('Practiced').closest('div')!).getByText('1')).toBeVisible()
    expect(screen.getByText(/Variation 2 of 2/u)).toBeVisible()
  })

  test('keeps failed cursor writes queued, visible, and retryable without browser storage', async () => {
    const user = userEvent.setup()
    const memory = new MemoryFamilyTrainingJournalRepository()
    let writable = false
    const repository: FamilyTrainingJournalRepository = {
      kind: 'memory',
      appendCoverageEvent: (event) => memory.appendCoverageEvent(event),
      appendCycleEvent: (event) => memory.appendCycleEvent(event),
      appendCursor: async (cursor) => {
        if (!writable) throw new Error('storage adapter rejected the write')
        return memory.appendCursor(cursor)
      },
      listCoverageEvents: (scope) => memory.listCoverageEvents(scope),
      listCycleEvents: (scope) => memory.listCycleEvents(scope),
      loadLatestCursor: (scope) => memory.loadLatestCursor(scope),
      loadCursor: (scope) => memory.loadCursor(scope),
    }
    render(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } }}
        dueCardIds={[]}
        orientation="white"
        reducedMotion
        familyId="synthetic-family"
        journalRepository={repository}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Start full opening' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/waiting to be saved/u)
    expect(screen.getByRole('alert')).toHaveTextContent(/1 progress change waiting to be saved/u)

    writable = true
    await user.click(screen.getByRole('button', { name: 'Retry saving progress' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(await memory.loadLatestCursor({
      releaseId: graph.releaseId,
      familyId: 'synthetic-family',
      packId: graph.pack.id,
      side: graph.pack.side,
    })).not.toBeNull()
  })

  test('does not stop or unmount the session until the latest cursor flush succeeds', async () => {
    const user = userEvent.setup()
    const memory = new MemoryFamilyTrainingJournalRepository()
    let writable = true
    const onStop = vi.fn()
    const repository: FamilyTrainingJournalRepository = {
      kind: 'memory',
      appendCoverageEvent: (event) => memory.appendCoverageEvent(event),
      appendCycleEvent: (event) => memory.appendCycleEvent(event),
      appendCursor: async (cursor) => {
        if (!writable) throw new Error('cursor store is unavailable')
        return memory.appendCursor(cursor)
      },
      listCoverageEvents: (scope) => memory.listCoverageEvents(scope),
      listCycleEvents: (scope) => memory.listCycleEvents(scope),
      loadLatestCursor: (scope) => memory.loadLatestCursor(scope),
      loadCursor: (scope) => memory.loadCursor(scope),
    }
    render(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } }}
        dueCardIds={[]}
        orientation="white"
        reducedMotion
        familyId="synthetic-family"
        journalRepository={repository}
        onStop={onStop}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Start full opening' }))
    await waitFor(async () => {
      expect(await memory.loadLatestCursor({
        releaseId: graph.releaseId,
        familyId: 'synthetic-family',
        packId: graph.pack.id,
        side: graph.pack.side,
      })).not.toBeNull()
    })

    writable = false
    const desktopControls = document.querySelector('.desktop-session-controls')
    if (!(desktopControls instanceof HTMLElement)) throw new Error('Desktop session controls are missing')
    await user.click(within(desktopControls).getByRole('button', { name: 'Stop training' }))
    expect(onStop).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Opening practice' })).toBeVisible()
    expect(await screen.findByRole('alert')).toHaveTextContent(/latest family progress was not saved|waiting to be saved/u)

    writable = true
    await user.click(screen.getByRole('button', { name: 'Retry saving progress' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    await user.click(within(desktopControls).getByRole('button', { name: 'Stop training' }))
    await waitFor(() => expect(onStop).toHaveBeenCalledTimes(1))
  })
})
