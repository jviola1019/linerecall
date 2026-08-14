// @vitest-environment jsdom

import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { DecompressionStream as NodeDecompressionStream } from 'node:stream/web'
import { Chess } from 'chess.js'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { App } from '../../src/app/App.tsx'
import {
  ChessBoard,
  moveStatusPresentation,
  uciForSquareMove,
} from '../../src/app/components/ChessBoard.tsx'
import { DataLicenses } from '../../src/app/components/DataLicenses.tsx'
import { DrillView } from '../../src/app/components/DrillView.tsx'
import { EvidenceTable } from '../../src/app/components/EvidenceTable.tsx'
import { OpeningBrowser, type PartitionResource } from '../../src/app/components/OpeningBrowser.tsx'
import { ProgressView } from '../../src/app/components/ProgressView.tsx'
import { EmptyState, ErrorState, LoadingState } from '../../src/app/components/ResourceState.tsx'
import { EmbeddedOpeningDataSource } from '../../src/data/embedded-opening-data-source.ts'
import type { EmbeddedSnapshotPayload } from '../../src/data/embedded-contract.ts'
import type {
  FamilyOpeningDataSource,
  OpeningDataCore,
  OpeningDataSource,
} from '../../src/data/opening-data-source.ts'
import { positionGraphFromWire } from '../../src/data/position-graph.ts'
import embeddedSnapshot from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import type { DataManifest, OpeningPartition, VerifiedLine } from '../../src/domain/opening-data.ts'
import type { OpeningFamilyCatalogV1 } from '../../src/domain/opening-family.ts'
import { createCard, createEmptyProgress, scheduleReview } from '../../src/domain/progress.ts'
import { MemoryProgressRepository } from '../../src/infrastructure/progress-repository.ts'
import { createSyntheticFamilyPromotion } from '../fixtures/synthetic-family-promotion.ts'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
Object.defineProperty(globalThis, 'Blob', { value: NodeBlob, configurable: true })
Object.defineProperty(globalThis, 'DecompressionStream', { value: NodeDecompressionStream, configurable: true })
Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test'), configurable: true })
Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true })

let core: OpeningDataCore
let audit: DataManifest
let c20: OpeningPartition
let a00: OpeningPartition
let drillLine: VerifiedLine

beforeAll(async () => {
  const source = new EmbeddedOpeningDataSource(embeddedSnapshot as EmbeddedSnapshotPayload)
  core = await source.initialize()
  ;[audit, c20, a00] = await Promise.all([source.loadAudit(), source.loadPartition('C20'), source.loadPartition('A00')])
  const candidate = c20.verifiedLines.find((line) => line.drillEligible)
  if (!candidate) throw new Error('C20 test fixture has no drillable line')
  drillLine = candidate
}, 30_000)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.replaceState(null, '', '#/today')
})

describe('accessible chess input', () => {
  test('supports keyboard, click-click, the move picker, statuses, and promotion', async () => {
    const user = userEvent.setup()
    const onMove = vi.fn()
    const { container, rerender } = render(
      <ChessBoard fen={new Chess().fen()} orientation="white" onMove={onMove} />,
    )
    expect(screen.getByRole('group', { name: 'Legal move picker' })).toBeTruthy()
    expect(container.querySelectorAll('.board-region [aria-live="polite"]')).toHaveLength(1)
    const e2 = screen.getByRole('gridcell', { name: /e2, White pawn/u })
    e2.focus()
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^e3,/u)
    await user.click(e2)
    expect(e2.getAttribute('aria-selected')).toBe('true')
    await user.click(screen.getByRole('gridcell', { name: /e4, empty, legal target/u }))
    expect(onMove).toHaveBeenCalledWith('e2e4')

    const picker = screen.getByRole('combobox', { name: 'Legal move picker' })
    await user.selectOptions(picker, 'g1f3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    expect(onMove).toHaveBeenCalledWith('g1f3')
    expect(uciForSquareMove('a7', 'a8', 'q')).toBe('a7a8q')
    expect(['book', 'playable', 'inaccuracy', 'mistake', 'unverified_deviation', 'illegal'].map((status) =>
      moveStatusPresentation(status as Parameters<typeof moveStatusPresentation>[0]).label,
    )).toEqual(['Book move', 'Playable alternative', 'Inaccuracy', 'Mistake', 'Unverified deviation', 'Illegal move'])

    const promotion = '8/P7/8/8/8/8/7p/4K2k w - - 0 1'
    rerender(<ChessBoard fen={promotion} orientation="black" onMove={onMove} />)
    await user.click(screen.getByRole('gridcell', { name: /a7, White pawn/u }))
    await user.click(screen.getByRole('gridcell', { name: /a8, empty, legal target/u }))
    const dialog = screen.getByRole('dialog', { name: 'Choose promotion piece' })
    expect(dialog).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Queen' }))
    expect(onMove).toHaveBeenCalledWith('a7a8q')
  })

  test('rejects disabled and illegal spatial interactions accessibly', async () => {
    const user = userEvent.setup()
    const onMove = vi.fn()
    const announce = vi.fn()
    const { container, rerender } = render(
      <ChessBoard fen={new Chess().fen()} orientation="white" onMove={onMove} onAnnouncement={announce} />,
    )
    expect(container.querySelectorAll('.board-region [aria-live]')).toHaveLength(0)
    await user.click(screen.getByRole('gridcell', { name: /e4, empty/u }))
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('has no legal moves'))
    rerender(<ChessBoard fen={new Chess().fen()} orientation="white" disabled onMove={onMove} />)
    expect(screen.getByRole('button', { name: 'Play move' })).toBeDisabled()
    const readOnlyE2 = screen.getByRole('gridcell', { name: /e2, White pawn/u })
    expect(readOnlyE2).toHaveAttribute('aria-disabled', 'true')
    readOnlyE2.focus()
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^e3,/u)
    await user.keyboard('{Enter}')
    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('opening browser and evidence', () => {
  test('searches text/moves/PGN and hands the selected taxonomy line to canonical family navigation', async () => {
    const user = userEvent.setup()
    const onSearch = vi.fn()
    const onOpenFamily = vi.fn()
    const resource: PartitionResource = { status: 'ready', value: c20, error: null }
    const announce = vi.fn()
    const { container } = render(
      <OpeningBrowser
        catalog={core.catalog}
        searchEntries={core.searchEntries}
        selectedEco="C20"
        selectedLineId={drillLine.sourceLineId}
        selectedVariantId={drillLine.id}
        partition={resource}
        onSelectEco={vi.fn()}
        onSelectLine={vi.fn()}
        onSelectVariant={vi.fn()}
        onSelectSearchResult={onSearch}
        onOpenFamily={onOpenFamily}
        onRetryPartition={vi.fn()}
        onAnnouncement={announce}
      />,
    )
    expect(screen.getByText(drillLine.name, { selector: 'h2' })).toBeTruthy()
    const search = screen.getByRole('searchbox', { name: /Search by opening name/u })
    await user.type(search, 'C20')
    await user.click(screen.getByRole('button', { name: 'Search openings' }))
    expect(await screen.findByText(/Search results/u)).toBeTruthy()
    expect(container.querySelector('.search-results')).not.toHaveAttribute('aria-live')
    expect(announce).toHaveBeenLastCalledWith(expect.stringMatching(/opening matches found/u))
    await user.click(screen.getAllByRole('button', { name: /C20/u })[0]!)
    expect(onSearch).toHaveBeenCalled()

    await user.click(screen.getByRole('radio', { name: 'Moves' }))
    const moves = screen.getByRole('searchbox', { name: /Paste a SAN/u })
    await user.type(moves, 'e4 e5')
    await user.click(screen.getByRole('button', { name: 'Search openings' }))
    expect(await screen.findByText(/Search results/u)).toBeTruthy()

    await user.click(screen.getByRole('radio', { name: 'PGN' }))
    await user.type(screen.getByRole('textbox', { name: /Paste a Standard/u }), '<script>')
    await user.click(screen.getByRole('button', { name: 'Search openings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/malformed|does not contain/u)
    expect(announce).not.toHaveBeenLastCalledWith(expect.stringMatching(/^Search error:/u))

    expect(screen.queryByRole('button', { name: 'Start spaced-repetition drill' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open opening family' }))
    expect(onOpenFamily).toHaveBeenCalledWith(drillLine.sourceLineId)
  }, 15_000)

  test('renders loading, empty, error, low-sample, and no-game states', async () => {
    const retry = vi.fn()
    const { rerender } = render(<LoadingState label="Loading test" />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading test')
    rerender(<ErrorState title="Failed" detail="Corrupt" onRetry={retry} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalled()
    rerender(<EmptyState title="Empty" detail="No data" />)
    expect(screen.getByText('No data')).toBeTruthy()

    const bands = c20.lines[0]!.terminalWhiteStats.map((band, index) => index === 0
      ? { ...band, n: 0, whiteWins: 0, draws: 0, blackWins: 0, wins: 0, losses: 0, winRate: null, drawRate: null, lossRate: null, lowSample: false }
      : { ...band, lowSample: true })
    rerender(<EvidenceTable bands={bands} caption="Test evidence" />)
    expect(screen.getAllByText('No games').length).toBeGreaterThan(0)
    expect(screen.getAllByText('low sample').length).toBeGreaterThan(0)
  })
})

describe('drill, progress, provenance, and top-level state', () => {
  test('runs hint, move, and automatic review flow against audited evidence without a grade interruption', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    const graph = positionGraphFromWire(core.search)
    render(
      <DrillView
        line={drillLine}
        graph={graph}
        progress={createEmptyProgress(new Date('2026-07-11T00:00:00.000Z'))}
        orientation="white"
        onSetOrientation={vi.fn()}
        onReview={onReview}
        onAnnouncement={vi.fn()}
        onReturnToBrowser={vi.fn()}
      />,
    )
    expect(screen.getByRole('group', { name: 'Session progress' })).toBeTruthy()
    const node = drillLine.nodes[0]!
    await user.click(screen.getByRole('button', { name: /Show hint/u }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), node.expectedMoveUci)
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    expect(await screen.findByText('Session complete')).toBeTruthy()
    expect(onReview).toHaveBeenCalledOnce()
    expect(screen.queryByRole('group', { name: /Choose recall grade/u })).toBeNull()
    expect(screen.getByText(/Last move recorded as hard/u)).toBeTruthy()
  })

  test('imports/exports progress and renders exact audit provenance', async () => {
    const user = userEvent.setup()
    const progress = createEmptyProgress(new Date('2026-07-11T00:00:00.000Z'))
    const cardId = `${drillLine.id}::${drillLine.nodes[0]!.id}`
    const card = scheduleReview(
      createCard(cardId, drillLine.id, drillLine.nodes[0]!.id, new Date('2026-07-10T00:00:00.000Z')),
      'good',
      new Date('2026-07-11T00:00:00.000Z'),
    ).card
    progress.cards[cardId] = card
    const { rerender } = render(
      <ProgressView
        progress={progress}
        variantSummaries={core.variantSummaries}
        searchEntries={core.searchEntries}
        repositoryKind="memory"
        storageWarning="Session only"
        saveError={null}
        onImport={vi.fn()}
        onAnnouncement={vi.fn()}
      />,
    )
    expect(screen.getByText('Session only')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Export progress JSON' }))
    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(document.body.querySelector('a[download]')).not.toBeNull()
    document.body.querySelector('a[download]')?.remove()
    const input = screen.getByLabelText('Choose progress JSON')
    await user.upload(input, new File(['{'], 'bad.json', { type: 'application/json' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid JSON/u)

    rerender(<DataLicenses audit={audit} selectedLine={drillLine} />)
    expect(screen.getByText('1,146,297')).toBeTruthy()
    expect(screen.getByText('800,176')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3, name: new RegExp(drillLine.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u') })).toBeTruthy()
    expect(screen.getByText(audit.engine.binarySha256)).toBeTruthy()
    expect(audit.crosscheck.discrepancyIndex).toHaveLength(audit.crosscheck.discrepancies)
    await user.click(screen.getByText(/Derived discrepancy index/u))
    expect(screen.getByRole('table', { name: /sampled lines with a derived discrepancy outcome/u })).toBeTruthy()
    expect(screen.getByText(/Scid opening names, moves, and oracle entries are not shipped/u)).toBeTruthy()
    await user.click(screen.getByText(/learner decision-node engine checks/u))
    const multiPvTables = screen.getAllByRole('table', { name: 'Stored Stockfish MultiPV analysis' })
    expect(multiPvTables).toHaveLength(drillLine.nodes.length)
    expect(within(multiPvTables[0]!).getByText(drillLine.nodes[0]!.engine.topVariations[0]!.movesUci.join(' '))).toBeTruthy()
  })

  test('renders named opening and trained-side progress with all learner cards in mastery totals', () => {
    const reviewedAt = new Date('2026-07-11T00:00:00.000Z')
    const progress = createEmptyProgress(reviewedAt)
    const card = {
      ...scheduleReview(
        createCard('grouped-card', drillLine.id, drillLine.nodes[0]!.id, reviewedAt),
        'good',
        reviewedAt,
      ).card,
      repetitions: 1,
      intervalDays: 30,
      // Keep the reviewed card outside the due set regardless of when the
      // regression suite is run; only the remaining new cards should be due.
      dueAt: '2099-08-10T00:00:00.000Z',
    }
    progress.cards[card.cardId] = card
    progress.openingStreaks[drillLine.sourceLineId] = { current: 3, lastLocalDate: '2026-07-11' }
    progress.variationStreaks[drillLine.id] = { current: 2, lastLocalDate: '2026-07-11' }
    render(
      <ProgressView
        progress={progress}
        variantSummaries={core.variantSummaries}
        searchEntries={core.searchEntries}
        repositoryKind="memory"
        storageWarning={null}
        saveError={null}
        onImport={vi.fn()}
        onAnnouncement={vi.fn()}
      />,
    )

    const openingTable = screen.getByRole('table', { name: /1 started opening/u })
    const openingRow = within(openingTable).getByRole('row', { name: new RegExp(drillLine.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u') })
    const openingCards = core.variantSummaries
      .filter((variant) => variant.sourceLineId === drillLine.sourceLineId)
      .reduce((sum, variant) => sum + variant.cardCount, 0)
    const openingCells = within(openingRow).getAllByRole('cell')
    expect(openingCells[0]).toHaveTextContent(`${Math.round(100 / openingCards)}%`)
    expect(openingCells[1]).toHaveTextContent(/^1$/u)
    expect(openingCells[2]).toHaveTextContent(`${openingCards - 1}`)
    expect(openingCells[3]).toHaveTextContent(`${openingCards}`)
    expect(openingCells[4]).toHaveTextContent('3 days')
    expect(openingCells[5]).toHaveTextContent('2026-07-11T00:00:00.000Z')

    const variationTable = screen.getByRole('table', { name: /trained-side variations in started openings/u })
    const trainedSide = drillLine.trainedSide === 'white' ? 'White' : 'Black'
    const variationRow = within(variationTable).getByRole('row', { name: new RegExp(`Train ${trainedSide}`, 'u') })
    const variationCells = within(variationRow).getAllByRole('cell')
    expect(variationCells[0]).toHaveTextContent(`${Math.round(100 / drillLine.nodes.length)}%`)
    expect(variationCells[1]).toHaveTextContent(/^1$/u)
    expect(variationCells[2]).toHaveTextContent(`${drillLine.nodes.length - 1}`)
    expect(variationCells[3]).toHaveTextContent(`${drillLine.nodes.length}`)
    expect(variationCells[4]).toHaveTextContent('2 days')
    expect(variationCells[5]).toHaveTextContent('2026-07-11T00:00:00.000Z')
    expect(screen.getByText(/streaks count consecutive local calendar days/iu)).toBeTruthy()
  })

  test('top-level app exposes loading, retry, navigation, theme, and persistence fallback', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const loadAudit = vi.fn(async () => audit)
    const dataSource: OpeningDataSource = {
      initialize: vi.fn(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('checksum rejected')
        return core
      }),
      loadPartition: vi.fn(async (eco) => eco === 'A00' ? a00 : c20),
      loadAudit,
    }
    render(<App dataSource={dataSource} />)
    expect(screen.getByRole('status')).toHaveTextContent(/Verifying/u)
    expect(await screen.findByText('Opening database unavailable')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeTruthy()
    expect(document.documentElement.lang).toBe('en-US')
    expect(document.documentElement.dir).toBe('ltr')
    expect(document.title).toBe('LineRecall — Audited Chess Opening Trainer')
    expect(await screen.findByText(/Session-only progress is active/u)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Progress' }))
    expect(screen.getByRole('heading', { name: 'Your progress' })).toBeTruthy()
    expect(screen.getAllByText(/Session-only progress is active/u)).toHaveLength(1)
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus())
    const themeToggle = screen.getByRole('button', { name: /Switch to light mode/u })
    expect(themeToggle).toHaveTextContent('Light mode')
    await user.click(themeToggle)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(screen.getByRole('button', { name: /Switch to dark mode/u })).toHaveTextContent('Dark mode')
    expect(loadAudit).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Data & licenses' }))
    expect(await screen.findByRole('heading', { name: 'Data & Licenses' })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus())
    expect(loadAudit).toHaveBeenCalledOnce()
    expect(screen.getByText('Data provenance and license records loaded.')).toBeTruthy()
  })

  test('keeps all five primary destinations distinct and identifies the current destination', async () => {
    const user = userEvent.setup()
    const dataSource: OpeningDataSource = {
      initialize: vi.fn(async () => core),
      loadPartition: vi.fn(async (eco) => eco === 'A00' ? a00 : c20),
      loadAudit: vi.fn(async () => audit),
    }
    const { container } = render(<App dataSource={dataSource} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Ready when you are.' })).toBeTruthy()

    const destinations = [
      { button: 'Today', view: 'today', heading: 'Ready when you are.' },
      { button: 'Repertoire', view: 'repertoire', heading: 'Repertoire' },
      { button: 'Puzzles', view: 'puzzles', heading: 'Puzzles' },
      { button: 'Explore', view: 'explore', heading: 'Explore openings' },
      { button: 'Progress', view: 'progress', heading: 'Your progress' },
    ] as const

    for (const destination of destinations) {
      const navButton = screen.getByRole('button', { name: destination.button })
      await user.click(navButton)
      expect(await screen.findByRole('heading', { level: 1, name: destination.heading })).toBeTruthy()
      expect(navButton).toHaveAttribute('aria-current', 'page')
      expect(container.querySelector('.view-stage')).toHaveAttribute('data-view', destination.view)
      expect(container.querySelectorAll('.primary-nav [aria-current="page"]')).toHaveLength(1)
    }
  })

  test('routes an Explore taxonomy row to its one canonical opening family', async () => {
    const user = userEvent.setup()
    const matchingFamilies = core.reviewFamilyCatalog.families.filter((family) =>
      family.taxonomyLineIds.includes(drillLine.sourceLineId))
    expect(matchingFamilies).toHaveLength(1)
    const family = matchingFamilies[0]!
    const dataSource: OpeningDataSource = {
      initialize: vi.fn(async () => core),
      loadPartition: vi.fn(async (eco) => eco === 'A00' ? a00 : c20),
      loadAudit: vi.fn(async () => audit),
    }

    render(<App dataSource={dataSource} />)
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Explore' }))
    await user.click(screen.getByRole('tab', { name: /Volume C:/u }))
    await user.click(within(screen.getByRole('listbox', { name: 'ECO opening codes' })).getByRole('option', { name: /^C20/u }))
    const lineList = await screen.findByRole('listbox', { name: 'C20 opening lines' })
    const option = within(lineList).getAllByRole('option').find((candidate) =>
      candidate.textContent?.includes(drillLine.name))
    if (!option) throw new Error('Expected taxonomy line is absent from Explore')
    await user.click(option)

    expect(screen.queryByRole('button', { name: 'Start spaced-repetition drill' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open opening family' }))
    expect(window.location.hash).toBe(`#/repertoire/${family.id}`)
    expect(await screen.findByRole('heading', { level: 1, name: family.canonicalName })).toBeVisible()
  })

  test('groups Repertoire by family and accepts only an explicitly supplied family graph', async () => {
    const user = userEvent.setup()
    const dataSource: OpeningDataSource = {
      initialize: vi.fn(async () => core),
      loadPartition: vi.fn(async (eco) => eco === 'A00' ? a00 : c20),
      loadAudit: vi.fn(async () => audit),
    }
    const first = render(<App dataSource={dataSource} />)
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Repertoire' }))
    expect(await screen.findByRole('heading', { name: 'Repertoire' })).toBeVisible()
    expect(screen.getAllByRole('button', { name: /Caro/u })).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Deep graph practice is not enabled' })).not.toBeInTheDocument()
    first.unmount()
    window.history.replaceState(null, '', '#/today')

    const family = core.reviewFamilyCatalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 1 })
    const progressRepository = new MemoryProgressRepository()
    render(
      <App
        dataSource={dataSource}
        repositorySelector={async () => ({ repository: progressRepository, warning: null })}
        familyGraphResources={{ 'caro-kann': promotion.resources }}
      />,
    )
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Repertoire' }))
    await user.click(screen.getByRole('button', { name: /Caro/u }))
    await user.click(await screen.findByRole('button', { name: 'Start full family' }))
    expect(await screen.findByRole('heading', { name: 'Practice every audited branch' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Start full repertoire' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'g1f3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    const rootCardId = promotion.graphs[0]!.nodes
      .find(({ id }) => id === promotion.graphs[0]!.pack.rootNodeId)?.cardId
    if (!rootCardId) throw new Error('Synthetic promotion root card is missing')
    await waitFor(async () => {
      expect((await progressRepository.load())?.cards[rootCardId]).toMatchObject({
        reviewCount: 1,
        repetitions: 1,
        intervalDays: 1,
      })
    })
    expect(await screen.findByText(/good review saved for this due card/iu)).toBeVisible()
  })

  test('loads every pack in a selected family from a validated family-capable source', async () => {
    const user = userEvent.setup()
    const family = core.reviewFamilyCatalog.families.find(({ id }) => id === 'caro-kann')
    if (!family) throw new Error('Required family is missing')
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    const loadRepertoirePack = vi.fn(async (packRef: typeof promotion.manifest.packRefs[number]) => {
      const graph = promotion.graphs.find(({ pack }) => pack.id === packRef.packId)
      if (!graph) throw new Error('Unknown fixture pack')
      return graph
    })
    const dataSource: FamilyOpeningDataSource = {
      familySchemaVersion: 1,
      initialize: vi.fn(async () => core),
      loadPartition: vi.fn(async (eco) => eco === 'A00' ? a00 : c20),
      loadAudit: vi.fn(async () => audit),
      loadFamilyCatalog: vi.fn(async (): Promise<OpeningFamilyCatalogV1> => ({
        schemaVersion: 1,
        releaseId: promotion.manifest.releaseId,
        generatedAt: '2026-07-28T12:00:00.000Z',
        taxonomyLineCount: core.reviewFamilyCatalog.taxonomyLineCount,
        familyCount: 1,
        families: [{
          schemaVersion: 1,
          id: family.id,
          canonicalName: family.canonicalName,
          aliases: family.aliases,
          ecoCodes: family.ecoCodes,
          taxonomyLineCount: family.taxonomyLineIds.length,
          packCount: promotion.manifest.packRefs.length,
          cardCount: promotion.graphs.reduce(
            (total, graph) => total + graph.nodes.filter(({ cardId }) => cardId !== undefined).length,
            0,
          ),
          availableSides: ['white'],
          manifestRef: promotion.manifest.provenanceRef,
        }],
      })),
      loadFamilyManifest: vi.fn(async () => promotion.manifest),
      loadRepertoirePack,
      loadPuzzleShard: vi.fn(async () => { throw new Error('No promoted tactical shard in this fixture') }),
    }

    render(<App dataSource={dataSource} />)
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Repertoire' }))
    await user.click(screen.getByRole('button', { name: /Caro/u }))
    await waitFor(() => expect(loadRepertoirePack).toHaveBeenCalledTimes(2))
    expect(new Set(loadRepertoirePack.mock.calls.map(([ref]) => ref.packId))).toEqual(
      new Set(promotion.manifest.packRefs.map(({ packId }) => packId)),
    )
    expect(await screen.findByText('2 audited packs ready')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Start full family' })).toBeEnabled()
  })

  test('commits navigation independently of a hostile native View Transition implementation', async () => {
    const user = userEvent.setup()
    const pending = new Promise<void>(() => undefined)
    const startViewTransition = vi.fn(() => ({ updateCallbackDone: pending }))
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    })
    const dataSource: OpeningDataSource = {
      initialize: vi.fn(async () => core),
      loadPartition: vi.fn(async (eco) => eco === 'A00' ? a00 : c20),
      loadAudit: vi.fn(async () => audit),
    }
    try {
      render(<App dataSource={dataSource} />)
      expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeTruthy()
      await user.click(screen.getByRole('button', { name: 'Progress' }))
      expect(await screen.findByRole('heading', { name: 'Your progress' })).toBeTruthy()
      expect(startViewTransition).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(document, 'startViewTransition')
    }
  })

  test('lazy audit exposes one loading or error announcement and retries without startup access', async () => {
    const user = userEvent.setup()
    let rejectAudit!: (reason: Error) => void
    const firstAudit = new Promise<DataManifest>((_resolve, reject) => { rejectAudit = reject })
    const loadAudit = vi.fn()
      .mockImplementationOnce(async () => firstAudit)
      .mockResolvedValueOnce(audit)
    const dataSource: OpeningDataSource = {
      initialize: vi.fn(async () => core),
      loadPartition: vi.fn(async (eco) => eco === 'A00' ? a00 : c20),
      loadAudit,
    }
    render(<App dataSource={dataSource} />)
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeTruthy()
    expect(loadAudit).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Data & licenses' }))
    expect(screen.getAllByText('Loading data provenance and licenses…')).toHaveLength(1)
    expect(screen.getByText('Loading data provenance and licenses…').closest('[role="status"]')).toBeTruthy()
    await act(async () => { rejectAudit(new Error('audit checksum rejected')) })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('audit checksum rejected')
    expect(screen.getAllByText('audit checksum rejected')).toHaveLength(1)

    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { name: 'Data & Licenses' })).toBeTruthy()
    expect(loadAudit).toHaveBeenCalledTimes(2)
    expect(screen.getAllByText('Data provenance and license records loaded.')).toHaveLength(1)
  })

  test('gates mutations until delayed progress hydration preserves the stored snapshot', async () => {
    document.documentElement.dataset.theme = 'dark'
    const user = userEvent.setup()
    const saved = createEmptyProgress(new Date('2026-07-10T00:00:00.000Z'))
    const node = drillLine.nodes[0]!
    const cardId = `${drillLine.id}::${node.id}`
    saved.cards[cardId] = scheduleReview(
      createCard(cardId, drillLine.id, node.id, new Date('2026-07-09T00:00:00.000Z')),
      'good',
      new Date('2026-07-10T00:00:00.000Z'),
    ).card
    saved.settings.theme = 'light'
    let resolveLoad!: (value: typeof saved) => void
    const delayedLoad = new Promise<typeof saved>((resolve) => { resolveLoad = resolve })
    const save = vi.fn(async (_progress: typeof saved) => undefined)
    const repository = {
      kind: 'memory' as const,
      load: vi.fn(async () => delayedLoad),
      save,
      clear: vi.fn(async () => undefined),
    }
    const dataSource: OpeningDataSource = {
      initialize: vi.fn(async () => core),
      loadPartition: vi.fn(async (eco) => eco === 'A00' ? a00 : c20),
      loadAudit: vi.fn(async () => audit),
    }
    render(<App dataSource={dataSource} repositorySelector={async () => ({ repository, warning: null })} />)

    expect(await screen.findByText('Loading saved progress…')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Switch to light mode/u })).toBeDisabled()
    expect(screen.queryByRole('heading', { name: 'Ready when you are.' })).toBeNull()
    expect(save).not.toHaveBeenCalled()

    await act(async () => resolveLoad(saved))
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeTruthy()
    const theme = screen.getByRole('button', { name: /Switch to dark mode/u })
    expect(theme).toBeEnabled()
    expect(save).not.toHaveBeenCalled()
    await user.click(theme)
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(Object.keys(save.mock.calls.at(-1)?.[0].cards ?? {})).toEqual([cardId])
  })
})
