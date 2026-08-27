import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../src/app/App.tsx'
import '../../src/app/styles.css'
import './review-harness.css'
import { EmbeddedSnapshotPayloadSchema } from '../../src/data/embedded-contract.ts'
import { EmbeddedOpeningDataSource } from '../../src/data/embedded-opening-data-source.ts'
import {
  TacticalPuzzleResourceSchema,
  isTrustedTacticalPuzzleResource,
  type TacticalPuzzleResource,
} from '../../src/data/tactical-puzzle-resource.ts'
import snapshotJson from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import {
  createSyntheticPuzzleResource,
  createSyntheticTacticalPuzzle,
} from '../fixtures/synthetic-tactical-puzzle.ts'
import { BoardMotionReview } from './BoardMotionReview.tsx'
import { createReviewFixtureDataSource } from './review-fixture-data.ts'

function requireRootContainer(): HTMLElement {
  const element = document.getElementById('root')
  if (!element) throw new Error('Review fixture root is missing')
  return element
}

const container = requireRootContainer()

function fixtureShell(content: React.JSX.Element): React.JSX.Element {
  return (
    <StrictMode>
      <div className="review-fixture-shell" data-review-fixture="synthetic-not-production">
        <p className="review-fixture-banner" role="note">
          Review fixture — synthetic data — not production
        </p>
        {content}
      </div>
    </StrictMode>
  )
}

function puzzleResourceFromQuery(): TacticalPuzzleResource {
  const searchParams = new URL(window.location.href).searchParams
  const requested = searchParams.get('puzzleState') ?? 'ready'
  const puzzleScenario = searchParams.get('puzzleScenario') ?? 'ordinary'
  const puzzle = puzzleScenario === 'promotion'
    ? createSyntheticTacticalPuzzle(
        '7k/1P6/6K1/8/8/8/8/r7 b - - 0 1',
        ['a1a2', 'b7b8q'],
        'Promo1',
      )
    : puzzleScenario === 'castling'
      ? createSyntheticTacticalPuzzle(
          '4k3/8/8/8/8/8/8/4K2R b K - 0 1',
          ['e8d7', 'e1g1'],
          'Castle1',
        )
      : puzzleScenario === 'en-passant'
        ? createSyntheticTacticalPuzzle(
            '4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1',
            ['d7d5', 'e5d6'],
            'EnPass1',
          )
        : puzzleScenario === 'alternate-mate'
          ? createSyntheticTacticalPuzzle(
              '7k/5Q2/6K1/8/8/8/8/r7 b - - 0 1',
              ['a1a2', 'f7e8'],
              'Mate01',
            )
          : createSyntheticTacticalPuzzle()
  const resources: Record<string, TacticalPuzzleResource> = {
    disabled: { status: 'disabled', reason: 'No tactical shard has passed release verification.' },
    loading: { status: 'loading' },
    ready: createSyntheticPuzzleResource([puzzle], { identity: `review-${puzzle.puzzleId}` }),
    empty: { status: 'empty', reason: 'No promoted puzzle matches the selected filters.' },
    stale: createSyntheticPuzzleResource([puzzle], {
      identity: `review-stale-${puzzle.puzzleId}`,
      status: 'stale',
      staleAt: '2026-07-28T12:00:00.000Z',
      reason: 'A refresh is pending.',
    }),
    offline: createSyntheticPuzzleResource([puzzle], {
      identity: `review-offline-${puzzle.puzzleId}`,
      status: 'offline',
      reason: 'Using the verified in-session shard.',
    }),
    'offline-empty': {
      status: 'offline',
      puzzles: [],
      reason: 'No verified puzzle shard is cached.',
      release: null,
    },
    'rate-limited': {
      status: 'rate-limited',
      retryAt: new Date(Date.now() + 60_000).toISOString(),
      retryAfterSeconds: 60,
      reason: 'Puzzle refresh is cooling down.',
    },
    corrupt: { status: 'corrupt', reason: 'The signed shard failed validation.' },
    error: { status: 'error', reason: 'The puzzle service did not respond.' },
  }
  const resource = resources[requested] ?? resources.ready!
  return isTrustedTacticalPuzzleResource(resource)
    ? resource
    : TacticalPuzzleResourceSchema.parse(resource)
}

async function mount(): Promise<void> {
  if (new URL(window.location.href).searchParams.get('surface') === 'board-motion') {
    createRoot(container).render(fixtureShell(<BoardMotionReview />))
    return
  }
  const snapshot = EmbeddedSnapshotPayloadSchema.parse(snapshotJson)
  const base = new EmbeddedOpeningDataSource(snapshot)
  const core = await base.initialize()
  const family = core.reviewFamilyCatalog.families.find(({ id }) => id === 'caro-kann')
  if (!family) throw new Error('The review fixture requires the canonical Caro-Kann family')
  const dataSource = await createReviewFixtureDataSource(base, family)
  const tacticalPuzzleResource = puzzleResourceFromQuery()

  createRoot(container).render(fixtureShell(
    <App
      dataSource={dataSource}
      tacticalPuzzleResource={tacticalPuzzleResource}
    />,
  ))
}

void mount().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Review fixture setup failed'
  createRoot(container).render(
    <main className="review-fixture-failure" role="alert">
      <h1>Review fixture unavailable</h1>
      <p>{message}</p>
    </main>,
  )
})
