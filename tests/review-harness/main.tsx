import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../src/app/App.tsx'
import '../../src/app/styles.css'
import './review-harness.css'
import { EmbeddedSnapshotPayloadSchema } from '../../src/data/embedded-contract.ts'
import { EmbeddedOpeningDataSource } from '../../src/data/embedded-opening-data-source.ts'
import { TacticalPuzzleResourceSchema } from '../../src/data/tactical-puzzle-resource.ts'
import snapshotJson from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import { createSyntheticTacticalPuzzle } from '../fixtures/synthetic-tactical-puzzle.ts'
import { createReviewFixtureDataSource } from './review-fixture-data.ts'

function requireRootContainer(): HTMLElement {
  const element = document.getElementById('root')
  if (!element) throw new Error('Review fixture root is missing')
  return element
}

const container = requireRootContainer()

async function mount(): Promise<void> {
  const snapshot = EmbeddedSnapshotPayloadSchema.parse(snapshotJson)
  const base = new EmbeddedOpeningDataSource(snapshot)
  const core = await base.initialize()
  const family = core.reviewFamilyCatalog.families.find(({ id }) => id === 'caro-kann')
  if (!family) throw new Error('The review fixture requires the canonical Caro-Kann family')
  const dataSource = await createReviewFixtureDataSource(base, family)
  const tacticalPuzzleResource = TacticalPuzzleResourceSchema.parse({
    status: 'ready',
    puzzles: [createSyntheticTacticalPuzzle()],
  })

  createRoot(container).render(
    <StrictMode>
      <div className="review-fixture-shell" data-review-fixture="synthetic-not-production">
        <p className="review-fixture-banner" role="note">
          Review fixture — synthetic data — not production
        </p>
        <App
          dataSource={dataSource}
          tacticalPuzzleResource={tacticalPuzzleResource}
        />
      </div>
    </StrictMode>,
  )
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
