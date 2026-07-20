// @vitest-environment jsdom

import { webcrypto } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { GraphTrainingBoundary } from '../../src/app/components/GraphTrainingBoundary.tsx'
import { GRAPH_TRAINING_CONTRACT_ID } from '../../src/domain/graph-training-session.ts'
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
    expect(screen.getByRole('heading', { name: 'Deep graph practice is not enabled' })).toBeVisible()
    expect(screen.getByText('No audited v3 pack has been promoted.')).toBeVisible()

    rerender(<GraphTrainingBoundary resource={{ status: 'loading' }} dueCardIds={[]} orientation="white" />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading the validated repertoire graph')

    rerender(<GraphTrainingBoundary resource={{ status: 'error', error: 'Graph shard is offline.' }} dueCardIds={[]} orientation="white" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Graph shard is offline.')

    rerender(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph: { schemaVersion: 1 } } }}
        dueCardIds={[]}
        orientation="white"
      />,
    )
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Repertoire graph rejected' })).toBeVisible())
  })

  test('lists every audited path and follows an alternate branch without a grade confirmation', async () => {
    const user = userEvent.setup()
    const reviews = vi.fn()
    const announcements = vi.fn()
    render(
      <GraphTrainingBoundary
        resource={{ status: 'ready', envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph } }}
        dueCardIds={[stableRepertoireCardId(graph.pack.id, graph.pack.rootNodeId)]}
        orientation="white"
        reducedMotion
        onInferredReview={reviews}
        onAnnouncement={announcements}
      />,
    )

    const pathSelect = await screen.findByLabelText('Path')
    const options = [...pathSelect.querySelectorAll('option')]
    expect(options).toHaveLength(graph.paths.length)
    expect(options.some((option) => option.textContent?.includes('Knight first'))).toBe(true)
    expect(options.some((option) => option.textContent?.includes('Fianchetto first'))).toBe(true)

    const knight = options.find((option) => option.textContent?.includes('Knight first'))!
    await user.selectOptions(pathSelect, knight.value)
    await user.click(screen.getByRole('button', { name: 'Practice selected path' }))
    expect(screen.getByRole('heading', { name: 'Continuous graph practice' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Again$|^Hard$|^Good$|^Easy$/u })).not.toBeInTheDocument()

    const picker = screen.getByRole('combobox', { name: 'Legal move picker' })
    await user.selectOptions(picker, 'g2g3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))

    expect(reviews).toHaveBeenCalledTimes(1)
    expect(reviews.mock.calls[0]?.[0]).toMatchObject({ grade: 'good', source: 'due', moveUci: 'g2g3' })
    expect(announcements).toHaveBeenCalledWith('Alternate audited branch accepted. Continuing from its exact resulting position.')
    expect(document.querySelector('[data-square="g3"][data-piece-type="wp"]')).not.toBeNull()
    await waitFor(() => expect(screen.getByText(/move 3 of 6/u)).toBeVisible())
  })

  test('full repertoire mode includes every path and a hint infers Hard for a due position', async () => {
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
    await user.click(await screen.findByRole('button', { name: 'Start full repertoire' }))
    const remaining = screen.getByText('Remaining paths').closest('div')
    expect(remaining).not.toBeNull()
    expect(within(remaining!).getByText(String(graph.paths.length))).toBeVisible()
    expect(screen.getByText(/Path 1 of 2/u)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Show hint' }))
    const picker = screen.getByRole('combobox', { name: 'Legal move picker' })
    await user.selectOptions(picker, 'g1f3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    expect(reviews.mock.calls[0]?.[0]).toMatchObject({ grade: 'hard', source: 'due' })
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
    await user.click(await screen.findByRole('button', { name: 'Start full repertoire' }))

    const play = async (uci: string): Promise<void> => {
      const picker = await screen.findByRole('combobox', { name: 'Legal move picker' })
      await waitFor(() => expect(picker).toBeEnabled())
      await user.selectOptions(picker, uci)
      await user.click(screen.getByRole('button', { name: 'Play move' }))
    }

    await play('g1f3')
    await waitFor(() => expect(screen.getByText(/move 3 of 6/u)).toBeVisible())
    await play('g2g3')
    await waitFor(() => expect(screen.getByText(/move 5 of 6/u)).toBeVisible())
    await play('f1g2')
    await waitFor(() => expect(screen.getByText(/Path 2 of 2/u)).toBeVisible())

    const completed = screen.getByText('Completed paths').closest('div')
    expect(completed).not.toBeNull()
    expect(within(completed!).getByText('1')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Fianchetto first' })).toBeVisible()

    await play('g2g3')
    await waitFor(() => expect(screen.getByText(/move 3 of 6/u)).toBeVisible())
    await play('g1f3')
    await waitFor(() => expect(screen.getByText(/move 5 of 6/u)).toBeVisible())
    await play('f1g2')

    expect(await screen.findByRole('heading', { name: 'Every selected path is complete.' })).toBeVisible()
    await waitFor(() => expect(completions).toHaveBeenCalledTimes(2))
    expect(new Set(completions.mock.calls.map(([completion]) => completion.pathId)).size).toBe(2)
    expect(completions.mock.calls[0]?.[0]).toMatchObject({
      contractId: 'linerecall.graph-path-completion.v1',
      schemaVersion: 1,
      releaseId: graph.releaseId,
      packId: graph.pack.id,
    })
  })

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
    await user.click(await screen.findByRole('button', { name: 'Practice selected path' }))
    const picker = screen.getByRole('combobox', { name: 'Legal move picker' })
    await user.selectOptions(picker, 'g1f3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))

    expect(reviews).toHaveBeenCalledWith(expect.objectContaining({ grade: 'good', source: 'due' }))
    const opponent = screen.getByRole('button', { name: 'Play opponent reply' })
    expect(opponent).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(opponent).toBeVisible()
    await user.click(opponent)
    await waitFor(() => expect(screen.getByText(/move 3 of 6/u)).toBeVisible())

    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'g2g3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    await user.click(screen.getByRole('button', { name: 'Play opponent reply' }))
    await waitFor(() => expect(screen.getByText(/move 5 of 6/u)).toBeVisible())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'f1g2')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    const boundary = screen.getByRole('button', { name: 'Continue to next path' })
    expect(boundary).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(boundary).toBeVisible()
  })
})
