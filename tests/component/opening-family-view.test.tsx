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

describe('canonical opening-family repertoire', () => {
  test('renders every canonical family once and keeps regression families singular', () => {
    render(<OpeningFamilyView {...catalogProps()} />)

    const list = screen.getByRole('list', { name: 'Opening families' })
    const search = screen.getByRole('searchbox', { name: 'Find an opening' })
    expect(screen.getByText(`${catalog.families.length} opening families match.`)).toBeVisible()
    expect(within(list).getAllByRole('listitem')).toHaveLength(36)

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
    while (screen.queryByRole('button', { name: 'Show more families' })) {
      fireEvent.click(screen.getByRole('button', { name: 'Show more families' }))
    }
    const allCards = [...list.querySelectorAll<HTMLButtonElement>('.family-card')]
    const names = allCards.map((button) => button.querySelector('strong')?.textContent)
    expect(allCards).toHaveLength(catalog.familyCount)
    expect(new Set(names).size).toBe(catalog.familyCount)
  }, 30_000)

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
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole('tab', { name: 'White' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Black' })).toHaveAttribute('aria-selected', 'false')

    await user.click(screen.getByRole('tab', { name: 'Black' }))
    expect(onSelectSide).toHaveBeenCalledWith(family.id, 'black')
    rerender(
      <OpeningFamilyView
        {...detailProps(family)}
        selectedSide="black"
        onSelectSide={onSelectSide}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Black' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('heading', { level: 1, name: family.canonicalName })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Training graph pending audit' })).toBeDisabled()
    expect(screen.getByText(/No shallow legacy rows are substituted/u)).toBeVisible()
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

    expect(screen.getByText('3 of 4 audited paths completed')).toBeVisible()
    const promoted = screen.getByText('Promoted graphs').closest('div')
    expect(promoted).not.toBeNull()
    expect(within(promoted!).getByText('1')).toBeVisible()
  })

  test('collapses duplicate variation labels without deleting distinct audited paths', async () => {
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
      />,
    )

    const syllabus = screen.getByRole('list', { name: `${family.canonicalName} variation syllabus` })
    expect(within(syllabus).getAllByRole('listitem')).toHaveLength(1)
    expect(within(syllabus).getByText('Shared variation')).toBeVisible()
    expect(within(syllabus).getByText('4 routes')).toBeVisible()
    expect(screen.getByText(/4 distinct paths across 2 packs/u)).toBeVisible()
    expect(screen.queryByText(/Untrusted graph label/u)).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab', { name: /pack/u })).toHaveLength(2)
    expect(screen.getByText('1', { selector: '.family-detail-facts dd' })).toBeVisible()
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

    const packTabs = screen.getAllByRole('tab', { name: /pack/u })
    expect(packTabs).toHaveLength(2)
    expect(packTabs[0]).toHaveAttribute('aria-selected', 'true')
    await user.click(packTabs[1]!)
    expect(packTabs[0]).toHaveAttribute('aria-selected', 'false')
    expect(packTabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole(
      'heading',
      { name: 'Practice every audited branch' },
      { timeout: 5_000 },
    )).toBeVisible()
    expect(screen.queryByText(/Untrusted graph label/u)).not.toBeInTheDocument()
    expect(screen.getByText('Manifest variation · Route 1 of 2')).toBeVisible()
    expect(screen.getByText('Manifest variation · Route 2 of 2')).toBeVisible()
  })

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
    await play('g2g3')
    await waitFor(() => expect(screen.getByText(/move 3 of 6/u)).toBeVisible())
    await play('g1f3')
    await waitFor(() => expect(screen.getByText(/move 5 of 6/u)).toBeVisible())
    await play('f1g2')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Path completion was not saved')
    const packTabs = screen.getAllByRole('tab', { name: /pack/u })
    expect(packTabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(packTabs[1]).toHaveAttribute('aria-selected', 'false')

    rejectSecondCompletion = false
    await user.click(within(alert).getByRole('button', { name: 'Retry saving completion' }))
    await waitFor(() => expect(packTabs[1]).toHaveAttribute('aria-selected', 'true'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  }, 20_000)

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
    expect(screen.getByRole('tab', { name: 'White' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Black' })).toBeVisible()
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
    expect(await screen.findByRole('heading', { name: 'Practice every audited branch' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Repertoire' })).toHaveAttribute('aria-current', 'page')
    expect(window.location.hash).toBe('#/train/caro-kann/white')
  })

  test('restores family catalog and detail through browser Back and Forward', async () => {
    const user = userEvent.setup()
    render(<App dataSource={appDataSource()} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Ready when you are.' })).toBeVisible()

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
    expect(screen.getByRole('heading', { name: 'Tactical puzzles are not released yet' })).toBeVisible()
    expect(screen.queryByText(/Find the repertoire move/u)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Repertoire' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Puzzles' })).toHaveAttribute('aria-current', 'page')
    expect(window.location.hash).toBe('#/puzzles')
  })
})
