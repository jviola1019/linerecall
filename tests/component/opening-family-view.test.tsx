// @vitest-environment jsdom

import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { DecompressionStream as NodeDecompressionStream } from 'node:stream/web'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { App } from '../../src/app/App.tsx'
import { OpeningFamilyView } from '../../src/app/components/OpeningFamilyView.tsx'
import { EmbeddedOpeningDataSource } from '../../src/data/embedded-opening-data-source.ts'
import type { EmbeddedSnapshotPayload } from '../../src/data/embedded-contract.ts'
import type { OpeningDataCore, OpeningDataSource } from '../../src/data/opening-data-source.ts'
import {
  validateReviewOpeningFamilyCatalog,
  type ReviewOpeningFamilyEntryV1,
} from '../../src/data/review-family-catalog.ts'
import { stableRepertoireCardId } from '../../src/domain/repertoire.ts'
import { MemoryFamilyTrainingJournalRepository } from '../../src/domain/family-training-journal.ts'
import { latestFamilyCoverageGeneration } from '../../src/domain/family-training-journal.ts'
import embeddedSnapshot from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import reviewFamilyCatalog from '../../src/generated/review-family-catalog.json' with { type: 'json' }
import { createSyntheticFamilyPromotion } from '../fixtures/synthetic-family-promotion.ts'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
Object.defineProperty(globalThis, 'Blob', { value: NodeBlob, configurable: true })
Object.defineProperty(globalThis, 'DecompressionStream', { value: NodeDecompressionStream, configurable: true })
Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true })

const catalog = validateReviewOpeningFamilyCatalog(reviewFamilyCatalog)
const originalInnerWidth = window.innerWidth
let core: OpeningDataCore
let source: EmbeddedOpeningDataSource

beforeAll(async () => {
  source = new EmbeddedOpeningDataSource(embeddedSnapshot as EmbeddedSnapshotPayload)
  core = await source.initialize()
}, 30_000)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.replaceState(null, '', '#/today')
  Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
})

afterAll(() => {
  Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
})

function appDataSource(): OpeningDataSource {
  return {
    initialize: vi.fn(async () => core),
    loadPartition: vi.fn(async (eco, signal) => source.loadPartition(eco, signal)),
    loadAudit: vi.fn(async (signal) => source.loadAudit(signal)),
  }
}

function catalogProps() {
  return {
    mode: 'catalog' as const,
    families: catalog.families,
    orientation: 'white' as const,
    onSelectFamily: vi.fn(),
    onSelectSide: vi.fn(),
    onStartTraining: vi.fn(),
    onBackToCatalog: vi.fn(),
    onOpenExplore: vi.fn(),
  }
}

function detailProps(family: ReviewOpeningFamilyEntryV1) {
  return {
    ...catalogProps(),
    mode: 'detail' as const,
    selectedFamilyId: family.id,
    selectedSide: 'white' as const,
  }
}

function courseSectionButtons(): HTMLButtonElement[] {
  const summary = screen.getByText('More course details')
  const details = summary.closest('details')
  if (!details) throw new Error('Course parts are missing')
  details.open = true
  fireEvent(details, new Event('toggle'))
  return within(screen.getByRole('group', { name: 'Course parts' })).getAllByRole('button')
}

describe('canonical opening-family repertoire', () => {
  test('renders every canonical family once and keeps regression families singular', () => {
    render(<OpeningFamilyView {...catalogProps()} />)

    const list = screen.getByRole('list', { name: 'Opening families' })
    const search = screen.getByRole('searchbox', { name: 'Find an opening' })
    expect(screen.getByText(`${catalog.families.length} openings shown.`)).toBeVisible()
    expect(within(list).getAllByRole('listitem')).toHaveLength(24)

    for (const [query, canonicalName] of [
      ['Caro', 'Caro–Kann'],
      ['Sicilian', 'Sicilian Defence'],
      ['Ruy', 'Ruy Lopez'],
    ] as const) {
      fireEvent.change(search, { target: { value: query } })
      const matches = within(list).getAllByRole('button')
        .filter((button) => button.querySelector('strong')?.textContent === canonicalName)
      expect(matches, `${canonicalName} must have exactly one family card`).toHaveLength(1)
    }

    fireEvent.change(search, { target: { value: '' } })
    while (screen.queryByRole('button', { name: 'Show more openings' })) {
      fireEvent.click(screen.getByRole('button', { name: 'Show more openings' }))
    }
    const allCards = [...list.querySelectorAll<HTMLButtonElement>('.family-card')]
    const names = allCards.map((button) => button.querySelector('strong')?.textContent)
    expect(allCards).toHaveLength(catalog.familyCount)
    expect(new Set(names).size).toBe(catalog.familyCount)
  }, 30_000)

  test('labels unpromoted one-side taxonomy families as reference-only', () => {
    const referenceOnly = catalog.families.find(({ availableSides }) => availableSides.length <= 1)
    if (!referenceOnly) throw new Error('A reference-only taxonomy family is required for this regression')
    render(<OpeningFamilyView {...catalogProps()} />)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find an opening' }), {
      target: { value: referenceOnly.canonicalName },
    })
    const card = within(screen.getByRole('list', { name: 'Opening families' }))
      .getAllByRole('button')
      .find((candidate) => candidate.textContent?.includes(referenceOnly.canonicalName))
    if (!card) throw new Error('Reference-only family card was not rendered')
    expect(card).toHaveTextContent(`${referenceOnly.taxonomyLineIds.length} reference lines`)
    expect(card).toHaveTextContent('Study only')
    expect(card).not.toHaveTextContent(/Train (?:White|Black|unavailable)/u)
  })

  test('keeps both learner sides inside one family detail and changes side without duplicating the page', async () => {
    const user = userEvent.setup()
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Caro–Kann regression family is missing')
    const onSelectSide = vi.fn()

    const { rerender } = render(
      <OpeningFamilyView
        {...detailProps(family)}
        onSelectSide={onSelectSide}
      />,
    )
    expect(screen.getAllByRole('heading', { level: 1, name: family.canonicalName })).toHaveLength(1)
    expect(within(screen.getByRole('group', { name: 'Practice side' })).getAllByRole('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'White' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Black' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: 'Black' }))
    expect(onSelectSide).toHaveBeenCalledWith(family.id, 'black')
    rerender(
      <OpeningFamilyView
        {...detailProps(family)}
        selectedSide="black"
        onSelectSide={onSelectSide}
      />,
    )
    expect(screen.getByRole('button', { name: 'Black' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('heading', { level: 1, name: family.canonicalName })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Practice unavailable' })).toBeDisabled()
    expect(screen.getByText(/Practice is not available for this side yet/u)).toBeVisible()
  })

  test('aggregates catalog completion totals across every manifest-owned pack', async () => {
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    render(
      <OpeningFamilyView
        {...catalogProps()}
        families={[family]}
        graphResources={{ [family.id]: promotion.resources }}
        completionCountByFamily={{ [family.id]: 3 }}
      />,
    )

    expect(screen.getByText('3 of 4 variations practiced')).toBeVisible()
    const promoted = screen.getByText('Ready to train').closest('div')
    expect(promoted).not.toBeNull()
    expect(within(promoted!).getByText('1')).toBeVisible()
  })

  test('collapses duplicate variation labels without deleting distinct audited paths', async () => {
    const user = userEvent.setup()
    const onStartBranchTraining = vi.fn()
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Caro–Kann regression family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, {
      packCount: 2,
      branchLabel: 'Shared variation',
    })

    render(
      <OpeningFamilyView
        {...detailProps(family)}
        graphResources={{ [family.id]: promotion.resources }}
        completionCountByFamily={{ [family.id]: 1 }}
        onStartBranchTraining={onStartBranchTraining}
      />,
    )

    const syllabus = screen.getByRole('list', { name: `${family.canonicalName} variation syllabus` })
    expect(within(syllabus).getAllByRole('listitem')).toHaveLength(1)
    expect(within(syllabus).getByText('Shared variation')).toBeVisible()
    expect(within(syllabus).getByText(/4 routes · 3 learner moves/u)).toBeVisible()
    expect(screen.getByText('Showing 1–1 of 1 named variations.')).toBeVisible()
    expect(screen.queryByText(/Untrusted graph label/u)).not.toBeInTheDocument()
    const courseDetails = screen.getByText('More course details').closest('details')
    expect(courseDetails).not.toBeNull()
    expect(courseDetails).not.toHaveAttribute('open')
    const branchPractice = within(syllabus).getByRole('button', { name: 'Practice Shared variation' })
    expect(branchPractice).toHaveClass('family-branch-practice')
    await user.click(branchPractice)
    expect(onStartBranchTraining).toHaveBeenCalledWith(family.id, 'white', expect.any(String))
    expect(courseSectionButtons()).toHaveLength(2)
    expect(screen.getByRole('heading', { name: '1 of 4 variations practiced' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Practice every variation' })).toBeVisible()
    fireEvent.click(screen.getByText('What is included'))
    expect(screen.getByText(/enough game evidence/u)).toBeVisible()
    expect(screen.getByText(/no grade screen between normal moves/u)).toBeVisible()
  })

  test('exposes and trains every signed pack on the selected side', async () => {
    const user = userEvent.setup()
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })

    render(
      <OpeningFamilyView
        {...detailProps(family)}
        mode="training"
        graphResources={{ [family.id]: promotion.resources }}
      />,
    )

    const packTabs = courseSectionButtons()
    expect(packTabs).toHaveLength(2)
    expect(packTabs[0]).toHaveAttribute('aria-pressed', 'true')
    await user.click(packTabs[1]!)
    expect(packTabs[0]).toHaveAttribute('aria-pressed', 'false')
    expect(packTabs[1]).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByRole(
      'heading',
      { name: 'Practice this opening' },
      { timeout: 5_000 },
    )).toBeVisible()
    expect(screen.queryByText(/Untrusted graph label/u)).not.toBeInTheDocument()
    expect(screen.getByText('Manifest variation · Route 1 of 2')).toBeVisible()
    expect(screen.getByText('Manifest variation · Route 2 of 2')).toBeVisible()
  })

  test('routes family-wide due cards only into their owning graph pack', async () => {
    const user = userEvent.setup()
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    const secondGraph = promotion.graphs[1]!
    const secondPackDueCard = stableRepertoireCardId(
      secondGraph.pack.id,
      secondGraph.pack.rootNodeId,
    )
    render(
      <OpeningFamilyView
        {...detailProps(family)}
        mode="training"
        reducedMotion
        graphResources={{ [family.id]: promotion.resources }}
        dueCardIds={[secondPackDueCard]}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Start full opening' }))
    expect(await screen.findByRole('heading', { name: 'Opening practice' })).toBeVisible()

    const packTabs = courseSectionButtons()
    await user.click(packTabs[1]!)
    expect(await screen.findByRole('heading', { name: 'Practice this opening' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Start full opening' }))
    expect(await screen.findByRole('heading', { name: 'Opening practice' })).toBeVisible()
    expect(screen.queryByText(/Due cards must belong to selected graph pack/u)).not.toBeInTheDocument()
  })

  test('branch-specific practice follows primary and secondary memberships across sibling packs', async () => {
    const user = userEvent.setup()
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    const manifest = structuredClone(promotion.manifest)
    const firstPackId = promotion.graphs[0]!.pack.id
    const firstPackMemberships = manifest.pathMemberships.filter(({ packId }) => packId === firstPackId)
    const sharedBranchId = firstPackMemberships[0]!.primaryBranchId
    const secondPackId = promotion.graphs[1]!.pack.id
    const secondPackMembership = manifest.pathMemberships.find(({ packId }) => packId === secondPackId)!
    secondPackMembership.secondaryBranchIds = [sharedBranchId]

    render(
      <OpeningFamilyView
        {...detailProps(family)}
        mode="training"
        reducedMotion
        graphResources={{
          [family.id]: {
            ...promotion.resources,
            manifest,
          },
        }}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Practice selected variation' }))
    expect(screen.getByText(/Variation 1 of 1/u)).toBeVisible()
    expect(screen.getByText('0 of 2 routes practiced in Manifest variation.')).toBeVisible()

    const play = async (uci: string): Promise<void> => {
      const picker = await screen.findByRole('combobox', { name: 'Legal move picker' })
      await waitFor(() => expect(picker).toBeEnabled())
      await user.selectOptions(picker, uci)
      await user.click(screen.getByRole('button', { name: 'Play move' }))
    }
    await play('g1f3')
    await waitFor(() => expect(screen.getByText(/1 of 3 moves recalled this run · decision 2 next/u)).toBeVisible())
    await play('g2g3')
    await waitFor(() => expect(screen.getByText(/2 of 3 moves recalled this run · decision 3 next/u)).toBeVisible())
    await play('f1g2')
    const packButtons = courseSectionButtons()
    await waitFor(() => expect(packButtons[1]).toHaveAttribute('aria-pressed', 'true'))
    expect(await screen.findByRole('heading', { name: 'Opening practice' })).toBeVisible()
    expect(screen.getByText('1 of 2 routes practiced in Manifest variation.')).toBeVisible()
    await play('g1f3')
    await waitFor(() => expect(screen.getByText(/1 of 3 moves recalled this run · decision 2 next/u)).toBeVisible())
    await play('g2g3')
    await waitFor(() => expect(screen.getByText(/2 of 3 moves recalled this run · decision 3 next/u)).toBeVisible())
    await play('f1g2')

    expect(await screen.findByRole('heading', { name: 'Every selected variation is complete.' })).toBeVisible()
    expect(screen.getByText('2 of 2 routes practiced in Manifest variation.')).toBeVisible()
    expect(packButtons[1]).toHaveAttribute('aria-pressed', 'true')
  }, 30_000)

  test('restores a cross-pack named branch, auto-starts its next pack, and never double-counts completion', async () => {
    const user = userEvent.setup()
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    const manifest = structuredClone(promotion.manifest)
    const first = promotion.graphs[0]!
    const second = promotion.graphs[1]!
    const firstMembership = manifest.pathMemberships.find(({ packId, pathId }) =>
      packId === first.pack.id && pathId === first.paths[0]!.id)!
    const secondMembership = manifest.pathMemberships.find(({ packId, pathId }) =>
      packId === second.pack.id && pathId === second.paths[0]!.id)!
    secondMembership.primaryBranchId = firstMembership.primaryBranchId
    secondMembership.secondaryBranchIds = secondMembership.secondaryBranchIds
      .filter((branchId) => branchId !== firstMembership.primaryBranchId)
    const resources = { ...promotion.resources, manifest }
    const repository = new MemoryFamilyTrainingJournalRepository()
    const generationId = '70000000-0000-4000-8000-000000000001'
    const firstCycleId = `${first.pack.id}::coverage:3`
    await repository.appendCycleEvent({
      schemaVersion: 1,
      eventId: '70000000-0000-4000-8000-000000000002',
      releaseId: manifest.releaseId,
      familyId: family.id,
      side: 'white',
      generationId,
      generationOrdinal: 0,
      kind: 'pack_bound',
      packId: first.pack.id,
      packCoverageCycleId: firstCycleId,
      occurredAt: '2026-08-13T10:00:00.000Z',
    })
    await repository.appendCycleEvent({
      schemaVersion: 1,
      eventId: '70000000-0000-4000-8000-000000000003',
      releaseId: manifest.releaseId,
      familyId: family.id,
      side: 'white',
      generationId,
      generationOrdinal: 0,
      kind: 'cycle_started',
      occurredAt: '2026-08-13T10:00:00.000Z',
    })
    await repository.appendCoverageEvent({
      schemaVersion: 1,
      eventId: '70000000-0000-4000-8000-000000000004',
      releaseId: manifest.releaseId,
      familyId: family.id,
      packId: first.pack.id,
      pathId: first.paths[0]!.id,
      coverageCycleId: firstCycleId,
      completedAt: '2026-08-13T10:01:00.000Z',
    })
    await repository.appendCursor({
      schemaVersion: 1,
      releaseId: manifest.releaseId,
      familyId: family.id,
      side: 'white',
      coverageCycleId: firstCycleId,
      authoritativeDueCardIds: [],
      reviewedCardIds: [],
      completedPathIds: [first.paths[0]!.id],
      pendingPathIds: [],
      batchIndex: 0,
    })
    let completionOrdinal = 5
    const onPathCompleted = vi.fn(async (_familyId: string, completion: {
      packId: string
      pathId: string
      coverageCycleId: string
      completedAt: string
    }) => {
      await repository.appendCoverageEvent({
        schemaVersion: 1,
        eventId: `70000000-0000-4000-8000-${String(completionOrdinal++).padStart(12, '0')}`,
        releaseId: manifest.releaseId,
        familyId: family.id,
        packId: completion.packId,
        pathId: completion.pathId,
        coverageCycleId: completion.coverageCycleId,
        completedAt: completion.completedAt,
      })
    })
    const props = {
      ...detailProps(family),
      mode: 'training' as const,
      reducedMotion: true,
      graphResources: { [family.id]: resources },
      familyTrainingJournal: repository,
      onPathCompleted,
    }
    const firstRender = render(<OpeningFamilyView {...props} />)
    const packButtons = courseSectionButtons()
    await waitFor(() => expect(packButtons[1]).toHaveAttribute('aria-pressed', 'true'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Opening practice' })).toBeVisible())
    expect(screen.getByText('1 of 2 routes practiced in Manifest variation.')).toBeVisible()
    await waitFor(async () => {
      const generation = latestFamilyCoverageGeneration(await repository.listCycleEvents({
        releaseId: manifest.releaseId,
        familyId: family.id,
        side: 'white',
      }))
      expect(generation?.packCycleIds[second.pack.id]).toBe(`${second.pack.id}::coverage:0`)
      expect(await repository.loadCursor({
        releaseId: manifest.releaseId,
        familyId: family.id,
        side: 'white',
        packId: second.pack.id,
        coverageCycleId: `${second.pack.id}::coverage:0`,
      })).not.toBeNull()
    })
    firstRender.unmount()

    render(<OpeningFamilyView {...props} />)
    const restoredPackButtons = courseSectionButtons()
    await waitFor(() => expect(restoredPackButtons[1]).toHaveAttribute('aria-pressed', 'true'))
    expect(await screen.findByText('1 of 2 routes practiced in Manifest variation.')).toBeVisible()

    const play = async (uci: string): Promise<void> => {
      const picker = await screen.findByRole('combobox', { name: 'Legal move picker' })
      await waitFor(() => expect(picker).toBeEnabled())
      await user.selectOptions(picker, uci)
      await user.click(screen.getByRole('button', { name: 'Play move' }))
    }
    await play('g1f3')
    await waitFor(() => expect(screen.getByText(/1 of 3 moves recalled this run · decision 2 next/u)).toBeVisible())
    await play('g2g3')
    await waitFor(() => expect(screen.getByText(/2 of 3 moves recalled this run · decision 3 next/u)).toBeVisible())
    await play('f1g2')
    expect(await screen.findByText('2 of 2 routes practiced in Manifest variation.')).toBeVisible()
    await waitFor(async () => {
      expect(await repository.listCoverageEvents({
        releaseId: manifest.releaseId,
        familyId: family.id,
      })).toHaveLength(2)
    })
    cleanup()
    render(<OpeningFamilyView {...props} />)
    expect(await screen.findByText('2 of 2 routes practiced in Manifest variation.')).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await repository.listCoverageEvents({
      releaseId: manifest.releaseId,
      familyId: family.id,
    })).toHaveLength(2)
  }, 30_000)

  test('starting full practice after choosing paths records a new family generation', async () => {
    const user = userEvent.setup()
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    const repository = new MemoryFamilyTrainingJournalRepository()
    const firstPackId = promotion.graphs[0]!.pack.id

    render(
      <OpeningFamilyView
        {...detailProps(family)}
        mode="training"
        reducedMotion
        graphResources={{ [family.id]: promotion.resources }}
        familyTrainingJournal={repository}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Start full opening' }))
    expect(await screen.findByRole('heading', { name: 'Opening practice' })).toBeVisible()
    await waitFor(async () => {
      const generation = latestFamilyCoverageGeneration(await repository.listCycleEvents({
        releaseId: promotion.manifest.releaseId,
        familyId: family.id,
        side: 'white',
      }))
      expect(generation?.generationOrdinal).toBe(0)
      expect(generation?.packCycleIds[firstPackId]).toBe(`${firstPackId}::coverage:0`)
    })

    const desktopControls = document.querySelector('.desktop-session-controls')
    expect(desktopControls).not.toBeNull()
    await user.click(within(desktopControls as HTMLElement).getByRole('button', { name: 'Choose variation' }))
    expect(await screen.findByRole('heading', { name: 'Practice this opening' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Start full opening' }))
    expect(await screen.findByRole('heading', { name: 'Opening practice' })).toBeVisible()
    expect(screen.queryByText(/already binds this pack/u)).not.toBeInTheDocument()

    await waitFor(async () => {
      const generation = latestFamilyCoverageGeneration(await repository.listCycleEvents({
        releaseId: promotion.manifest.releaseId,
        familyId: family.id,
        side: 'white',
      }))
      expect(generation?.generationOrdinal).toBe(1)
      expect(generation?.packCycleIds).toEqual({
        [firstPackId]: `${firstPackId}::coverage:1`,
      })
    })
  }, 30_000)

  test('starts a named branch in a fresh durable generation and leaves single-path study unbound', async () => {
    const user = userEvent.setup()
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    const repository = new MemoryFamilyTrainingJournalRepository()
    const firstPackId = promotion.graphs[0]!.pack.id
    render(
      <OpeningFamilyView
        {...detailProps(family)}
        mode="training"
        reducedMotion
        graphResources={{ [family.id]: promotion.resources }}
        familyTrainingJournal={repository}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Start full opening' }))
    await waitFor(async () => expect((latestFamilyCoverageGeneration(await repository.listCycleEvents({
      releaseId: promotion.manifest.releaseId,
      familyId: family.id,
      side: 'white',
    })))?.generationOrdinal).toBe(0))
    const chooseVariation = (): HTMLButtonElement => within(
      document.querySelector('.desktop-session-controls')!,
    ).getByRole('button', { name: 'Choose variation' })
    await user.click(chooseVariation())
    await user.click(await screen.findByRole('button', { name: 'Practice selected variation' }))
    expect(await screen.findByRole('heading', { name: 'Opening practice' })).toBeVisible()
    await waitFor(async () => {
      const latest = latestFamilyCoverageGeneration(await repository.listCycleEvents({
        releaseId: promotion.manifest.releaseId,
        familyId: family.id,
        side: 'white',
      }))
      expect(latest?.generationOrdinal).toBe(1)
      expect(latest?.packCycleIds[firstPackId]).toBe(`${firstPackId}::coverage:1`)
    })

    await user.click(chooseVariation())
    await user.click(await screen.findByRole('button', { name: 'Practice selected line' }))
    expect(await screen.findByRole('heading', { name: 'Opening practice' })).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const afterSinglePath = latestFamilyCoverageGeneration(await repository.listCycleEvents({
      releaseId: promotion.manifest.releaseId,
      familyId: family.id,
      side: 'white',
    }))
    expect(afterSinglePath?.generationOrdinal).toBe(1)
    expect(afterSinglePath?.packCycleIds).toEqual({
      [firstPackId]: `${firstPackId}::coverage:1`,
    })
  }, 30_000)

  test('resumes a persisted family start that crashed before its first pack binding', async () => {
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    const repository = new MemoryFamilyTrainingJournalRepository()
    const generationId = '50000000-0000-4000-8000-000000000001'
    await repository.appendCycleEvent({
      schemaVersion: 1,
      eventId: '50000000-0000-4000-8000-000000000002',
      releaseId: promotion.manifest.releaseId,
      familyId: family.id,
      side: 'white',
      generationId,
      generationOrdinal: 0,
      kind: 'cycle_started',
      occurredAt: '2026-07-29T12:00:00.000Z',
    })

    render(
      <OpeningFamilyView
        {...detailProps(family)}
        mode="training"
        reducedMotion
        graphResources={{ [family.id]: promotion.resources }}
        familyTrainingJournal={repository}
      />,
    )

    expect(await screen.findByRole('heading', { name: 'Opening practice' })).toBeVisible()
    await waitFor(async () => {
      const generation = latestFamilyCoverageGeneration(await repository.listCycleEvents({
        releaseId: promotion.manifest.releaseId,
        familyId: family.id,
        side: 'white',
      }))
      const firstPackId = promotion.graphs[0]!.pack.id
      expect(generation?.generationId).toBe(generationId)
      expect(generation?.packCycleIds[firstPackId]).toBe(`${firstPackId}::coverage:0`)
    })
  }, 30_000)

  test('remount hydration skips completed packs and never double-counts replayed completion events', async () => {
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    const repository = new MemoryFamilyTrainingJournalRepository()
    const completedGraph = promotion.graphs[0]!
    const generationId = '10000000-0000-4000-8000-000000000001'
    expect(await repository.appendCycleEvent({
      schemaVersion: 1,
      eventId: '10000000-0000-4000-8000-000000000002',
      releaseId: completedGraph.releaseId,
      familyId: family.id,
      side: completedGraph.pack.side,
      generationId,
      generationOrdinal: 0,
      kind: 'cycle_started',
      occurredAt: '2026-07-29T11:59:00.000Z',
    })).toBe('appended')
    expect(await repository.appendCycleEvent({
      schemaVersion: 1,
      eventId: '10000000-0000-4000-8000-000000000003',
      releaseId: completedGraph.releaseId,
      familyId: family.id,
      side: completedGraph.pack.side,
      generationId,
      generationOrdinal: 0,
      kind: 'pack_bound',
      packId: completedGraph.pack.id,
      packCoverageCycleId: `${completedGraph.pack.id}::coverage:0`,
      occurredAt: '2026-07-29T11:59:01.000Z',
    })).toBe('appended')
    for (const [index, path] of completedGraph.paths.entries()) {
      const event = {
        schemaVersion: 1 as const,
        eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        releaseId: completedGraph.releaseId,
        familyId: family.id,
        packId: completedGraph.pack.id,
        pathId: path.id,
        coverageCycleId: `${completedGraph.pack.id}::coverage:0`,
        completedAt: `2026-07-29T12:0${index}:00.000Z`,
      }
      expect(await repository.appendCoverageEvent(event)).toBe('appended')
      expect(await repository.appendCoverageEvent(structuredClone(event))).toBe('duplicate')
    }
    expect(await repository.appendCursor({
      schemaVersion: 1,
      releaseId: completedGraph.releaseId,
      familyId: family.id,
      side: completedGraph.pack.side,
      coverageCycleId: `${completedGraph.pack.id}::coverage:0`,
      authoritativeDueCardIds: [],
      reviewedCardIds: [],
      completedPathIds: completedGraph.paths.map(({ id }) => id),
      pendingPathIds: [],
      batchIndex: 0,
    })).toBe('appended')
    const unrelatedSecondGraphCursor = promotion.graphs[1]!
    expect(await repository.appendCursor({
      schemaVersion: 1,
      releaseId: unrelatedSecondGraphCursor.releaseId,
      familyId: family.id,
      side: unrelatedSecondGraphCursor.pack.side,
      coverageCycleId: `${unrelatedSecondGraphCursor.pack.id}::coverage:4`,
      authoritativeDueCardIds: [],
      reviewedCardIds: [],
      completedPathIds: [],
      pendingPathIds: unrelatedSecondGraphCursor.paths.map(({ id }) => id),
      batchIndex: 0,
    })).toBe('appended')

    render(
      <OpeningFamilyView
        {...detailProps(family)}
        mode="training"
        reducedMotion
        graphResources={{ [family.id]: promotion.resources }}
        familyTrainingJournal={repository}
      />,
    )

    const packTabs = courseSectionButtons()
    await waitFor(() => expect(packTabs[1]).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByText('2 of 4 variations practiced this round.')).toBeVisible()
    expect(await screen.findByRole('heading', { name: 'Opening practice' })).toBeVisible()
    await waitFor(async () => {
      const events = await repository.listCycleEvents({
        releaseId: completedGraph.releaseId,
        familyId: family.id,
        side: completedGraph.pack.side,
      })
      expect(latestFamilyCoverageGeneration(events)?.packCycleIds).toEqual({
        [completedGraph.pack.id]: `${completedGraph.pack.id}::coverage:0`,
        [unrelatedSecondGraphCursor.pack.id]: `${unrelatedSecondGraphCursor.pack.id}::coverage:5`,
      })
    })
  })

  test('restores divergent pack cycles through one family generation and restarts coherently', async () => {
    const user = userEvent.setup()
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    const repository = new MemoryFamilyTrainingJournalRepository()
    const generationId = '30000000-0000-4000-8000-000000000001'
    await repository.appendCycleEvent({
      schemaVersion: 1,
      eventId: '30000000-0000-4000-8000-000000000002',
      releaseId: promotion.manifest.releaseId,
      familyId: family.id,
      side: 'white',
      generationId,
      generationOrdinal: 0,
      kind: 'cycle_started',
      occurredAt: '2026-07-29T10:00:00.000Z',
    })
    const packOrdinals = [7, 2] as const
    let eventSequence = 3
    for (const [packIndex, graph] of promotion.graphs.entries()) {
      const coverageCycleId = `${graph.pack.id}::coverage:${packOrdinals[packIndex]!}`
      await repository.appendCycleEvent({
        schemaVersion: 1,
        eventId: `30000000-0000-4000-8000-${String(eventSequence++).padStart(12, '0')}`,
        releaseId: graph.releaseId,
        familyId: family.id,
        side: graph.pack.side,
        generationId,
        generationOrdinal: 0,
        kind: 'pack_bound',
        packId: graph.pack.id,
        packCoverageCycleId: coverageCycleId,
        occurredAt: `2026-07-29T10:0${packIndex + 1}:00.000Z`,
      })
      await repository.appendCursor({
        schemaVersion: 1,
        releaseId: graph.releaseId,
        familyId: family.id,
        side: graph.pack.side,
        coverageCycleId,
        authoritativeDueCardIds: [],
        reviewedCardIds: [],
        completedPathIds: graph.paths.map(({ id }) => id),
        pendingPathIds: [],
        batchIndex: 0,
      })
      for (const path of graph.paths) {
        await repository.appendCoverageEvent({
          schemaVersion: 1,
          eventId: `30000000-0000-4000-8000-${String(eventSequence++).padStart(12, '0')}`,
          releaseId: graph.releaseId,
          familyId: family.id,
          packId: graph.pack.id,
          pathId: path.id,
          coverageCycleId,
          completedAt: `2026-07-29T10:${String(eventSequence).padStart(2, '0')}:00.000Z`,
        })
      }
    }

    render(
      <OpeningFamilyView
        {...detailProps(family)}
        mode="training"
        reducedMotion
        graphResources={{ [family.id]: promotion.resources }}
        familyTrainingJournal={repository}
      />,
    )
    expect(await screen.findByText('4 of 4 variations practiced this round.')).toBeVisible()
    expect(await screen.findByRole('heading', { name: 'Every selected variation is complete.' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Start a new practice round' }))
    expect(await screen.findByRole('heading', { name: 'Opening practice' })).toBeVisible()
    expect(screen.getByText('0 of 4 variations practiced this round.')).toBeVisible()
    await waitFor(async () => {
      const events = await repository.listCycleEvents({
        releaseId: promotion.manifest.releaseId,
        familyId: family.id,
        side: 'white',
      })
      const latest = latestFamilyCoverageGeneration(events)
      expect(latest?.generationOrdinal).toBe(1)
      expect(latest?.packCycleIds).toEqual({
        [promotion.graphs[0]!.pack.id]: `${promotion.graphs[0]!.pack.id}::coverage:8`,
      })
    })
  }, 30_000)

  test('does not advance packs until a rejected completion is saved on retry', async () => {
    const user = userEvent.setup()
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    let rejectSecondCompletion = true
    const onPathCompleted = vi.fn(async (
      _familyId: string,
      completion: { pathId: string },
    ) => {
      if (rejectSecondCompletion && completion.pathId === promotion.graphs[0]!.paths[1]!.id) {
        throw new Error('Synthetic repository rejection')
      }
    })

    render(
      <OpeningFamilyView
        {...detailProps(family)}
        mode="training"
        reducedMotion
        graphResources={{ [family.id]: promotion.resources }}
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
    await waitFor(() => expect(screen.getByText(/1 of 3 moves recalled this run · decision 2 next/u)).toBeVisible())
    await play('g2g3')
    await waitFor(() => expect(screen.getByText(/2 of 3 moves recalled this run · decision 3 next/u)).toBeVisible())
    await play('f1g2')
    await waitFor(() => expect(screen.getByText(/Variation 2 of 2/u)).toBeVisible())
    await play('g2g3')
    await waitFor(() => expect(screen.getByText(/1 of 3 moves recalled this run · decision 2 next/u)).toBeVisible())
    await play('g1f3')
    await waitFor(() => expect(screen.getByText(/2 of 3 moves recalled this run · decision 3 next/u)).toBeVisible())
    await play('f1g2')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This completed variation is not saved yet')
    const packTabs = courseSectionButtons()
    expect(packTabs[0]).toHaveAttribute('aria-pressed', 'true')
    expect(packTabs[1]).toHaveAttribute('aria-pressed', 'false')

    rejectSecondCompletion = false
    await user.click(within(alert).getByRole('button', { name: 'Retry this variation' }))
    await waitFor(() => expect(packTabs[1]).toHaveAttribute('aria-pressed', 'true'))
    expect(await screen.findByRole('heading', { name: 'Opening practice' })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  }, 20_000)

  test('ignores a completion that resolves after navigation instead of mutating the new family view', async () => {
    const user = userEvent.setup()
    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    let releaseSecondCompletion!: () => void
    const secondCompletionPending = new Promise<void>((resolve) => { releaseSecondCompletion = resolve })
    const onPathCompleted = vi.fn(async (_familyId: string, completion: { pathId: string }) => {
      if (completion.pathId === promotion.graphs[0]!.paths[1]!.id) await secondCompletionPending
    })
    const props = {
      ...detailProps(family),
      reducedMotion: true,
      graphResources: { [family.id]: promotion.resources },
      onPathCompleted,
    }
    const view = render(<OpeningFamilyView {...props} mode="training" />)
    await user.click(await screen.findByRole('button', { name: 'Start full opening' }))
    const play = async (uci: string): Promise<void> => {
      const picker = await screen.findByRole('combobox', { name: 'Legal move picker' })
      await waitFor(() => expect(picker).toBeEnabled())
      await user.selectOptions(picker, uci)
      await user.click(screen.getByRole('button', { name: 'Play move' }))
    }
    for (const move of ['g1f3', 'g2g3', 'f1g2', 'g2g3', 'g1f3', 'f1g2']) await play(move)
    await waitFor(() => expect(onPathCompleted).toHaveBeenCalledTimes(2))

    view.rerender(<OpeningFamilyView {...props} mode="detail" />)
    await act(async () => { releaseSecondCompletion(); await secondCompletionPending })
    view.rerender(<OpeningFamilyView {...props} mode="training" />)

    const packTabs = courseSectionButtons()
    expect(packTabs[0]).toHaveAttribute('aria-pressed', 'true')
    expect(packTabs[1]).toHaveAttribute('aria-pressed', 'false')
  }, 30_000)

  test('puts search, family results, and an actionable family card before audit-only notices at mobile width', () => {
    Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true })
    window.dispatchEvent(new Event('resize'))
    const onSelectFamily = vi.fn()
    const props = catalogProps()
    render(<OpeningFamilyView {...props} onSelectFamily={onSelectFamily} />)

    const view = screen.getByRole('heading', { level: 1, name: 'Repertoire' }).closest('section')
    const search = screen.getByRole('searchbox', { name: 'Find an opening' })
    const list = screen.getByRole('list', { name: 'Opening families' })
    const firstCard = within(list).getAllByRole('button')[0]
    if (!view || !firstCard) throw new Error('Mobile family catalog controls are missing')

    expect(view.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy()
    expect(search.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(firstCard).toBeEnabled()
    expect(view.querySelector('.resource-notice')).toBeNull()
    expect(view.querySelector('.family-card-grid')).not.toBeNull()
  })
})

describe('family hash routing and tactical-route isolation', () => {
  test('opens family detail and training deep links with Repertoire marked current', async () => {
    window.history.replaceState(null, '', '#/repertoire/caro-kann')
    const detail = render(<App dataSource={appDataSource()} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Caro–Kann' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Repertoire' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'White' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Black' })).toBeVisible()
    detail.unmount()

    const family = catalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 1 })
    window.history.replaceState(null, '', '#/train/caro-kann/white')
    render(
      <App
        dataSource={appDataSource()}
        familyGraphResources={{ 'caro-kann': promotion.resources }}
      />,
    )
    expect(await screen.findByRole('heading', { level: 1, name: 'Caro–Kann' })).toBeVisible()
    expect(await screen.findByRole('heading', { name: 'Practice this opening' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Repertoire' })).toHaveAttribute('aria-current', 'page')
    expect(window.location.hash).toBe('#/train/caro-kann/white')
  })

  test('restores family catalog and detail through browser Back and Forward', async () => {
    const user = userEvent.setup()
    render(<App dataSource={appDataSource()} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Your opening practice' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Repertoire' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Repertoire' })).toBeVisible()
    await user.type(screen.getByRole('searchbox', { name: 'Find an opening' }), 'Caro')
    await user.click(within(screen.getByRole('list', { name: 'Opening families' })).getByRole('button'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Caro–Kann' })).toBeVisible()

    await act(async () => window.history.back())
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Repertoire' })).toBeVisible())
    expect(window.location.hash).toBe('#/repertoire')

    await act(async () => window.history.forward())
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Caro–Kann' })).toBeVisible())
    expect(window.location.hash).toBe('#/repertoire/caro-kann')
  })

  test('deep-links to tactical Puzzles without rendering opening-recall content', async () => {
    window.history.replaceState(null, '', '#/puzzles')
    render(<App dataSource={appDataSource()} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Puzzles' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Verified puzzles aren’t included in this build yet.' })).toBeVisible()
    expect(screen.queryByText(/Find the repertoire move/u)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Repertoire' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Puzzles' })).toHaveAttribute('aria-current', 'page')
    expect(window.location.hash).toBe('#/puzzles')
  })
})
