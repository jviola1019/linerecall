import { Component, StrictMode, useCallback, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/app/styles.css'
import './hosted.css'
import { App } from '../../src/app/App.tsx'
import type { PuzzleAttemptEventV1 } from '../../src/domain/puzzle-progress.ts'
import { EmbeddedSnapshotPayloadSchema } from '../../src/data/embedded-contract.ts'
import { EmbeddedOpeningDataSource } from '../../src/data/embedded-opening-data-source.ts'
import { MemoryProgressRepository } from '../../src/infrastructure/progress-repository.ts'
import snapshotJson from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import { AccountControl } from './AccountControl.tsx'
import { AuthService } from './auth-service.ts'
import type { AuthSession } from './contracts.ts'
import { CloudFamilyTrainingJournalRepository } from './family-training-client.ts'
import {
  CloudProgressRepository,
  CloudPuzzleProgressRepository,
  ConnectedSyncClient,
  type SyncState,
} from './sync-client.ts'

const snapshot = EmbeddedSnapshotPayloadSchema.parse(snapshotJson)
const defaultSnapshotVersion = `wire_${snapshot.generatedAt.replace(/[^A-Za-z0-9._-]/gu, '_')}`
const configuredSnapshotVersion = import.meta.env.VITE_SNAPSHOT_VERSION as string | undefined
const snapshotVersion = configuredSnapshotVersion?.trim() || defaultSnapshotVersion
const dataSource = new EmbeddedOpeningDataSource(snapshot)
const auth = new AuthService()
let providerCallback: Promise<void> | null = null

interface ErrorBoundaryState { error: Error | null }

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo): void { console.error('LineRecall hosted render failure', error, info.componentStack) }
  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <main id="main-content" className="startup-state">
        <div className="resource-state error-state" role="alert">
          <span className="state-icon" aria-hidden="true">!</span>
          <h1>LineRecall could not continue</h1>
          <p>{this.state.error.message || 'The connected client encountered an unexpected error.'}</p>
          <button type="button" onClick={() => window.location.reload()}>Reload the app</button>
          <p className="field-help">Queued reviews exist only in memory until the service accepts them. Export before reloading whenever the account dialog is still available.</p>
        </div>
      </main>
    )
  }
}

function HostedRoot(): React.JSX.Element {
  const [sessionStatus, setSessionStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [session, setSession] = useState<AuthSession | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [syncState, setSyncState] = useState<SyncState | null>(null)
  const [clientError, setClientError] = useState<string | null>(null)
  const [familyPendingCount, setFamilyPendingCount] = useState(0)

  useEffect(() => {
    let active = true
    const initialize = async (): Promise<void> => {
      try {
        if (window.location.pathname === '/connections/lichess/callback') {
          const parameters = new URLSearchParams(window.location.search)
          const providerError = parameters.get('error')
          if (providerError) throw new Error('Lichess declined or could not complete the connection request')
          const code = parameters.get('code')
          const state = parameters.get('state')
          if (!code || !state) throw new Error('The Lichess callback is missing required values')
          providerCallback ??= auth.completeLichessConnection(code, state)
          await providerCallback
          window.history.replaceState(null, '', '/')
        }
        const current = await auth.session()
        if (!active) return
        setSession(current)
        setSessionStatus('ready')
      } catch (cause) {
        if (!active) return
        setSessionError(cause instanceof Error ? cause.message : 'Account session could not be checked')
        setSessionStatus('error')
      }
    }
    void initialize()
    return () => { active = false }
  }, [])

  const sync = useMemo(
    () => session ? new ConnectedSyncClient({ snapshotVersion }) : null,
    [session?.user.id],
  )
  const familyTrainingJournal = useMemo(
    () => sync ? new CloudFamilyTrainingJournalRepository({
      deviceId: sync.deviceId,
      onError: (error) => setClientError(error.message),
      onPendingChange: setFamilyPendingCount,
    }) : undefined,
    [sync],
  )

  useEffect(() => {
    if (!sync) { setSyncState(null); setFamilyPendingCount(0); return }
    const unsubscribe = sync.subscribeStatus(setSyncState)
    const online = (): void => {
      void sync.flush()
      void familyTrainingJournal?.flush().catch((error: unknown) => {
        setClientError(error instanceof Error ? error.message : 'Family progress could not be synchronized')
      })
    }
    window.addEventListener('online', online)
    return () => {
      unsubscribe()
      window.removeEventListener('online', online)
    }
  }, [familyTrainingJournal, sync])

  const repositorySelector = useCallback(async () => {
    if (sync) return { repository: new CloudProgressRepository(sync), warning: null }
    return {
      repository: new MemoryProgressRepository(),
      warning: 'Not signed in. Progress is session-only; use validated JSON export before leaving.',
    }
  }, [sync])
  const puzzleProgressRepository = useMemo(
    () => sync ? new CloudPuzzleProgressRepository(sync) : undefined,
    [sync],
  )

  const commitReview = useCallback((commit: Parameters<ConnectedSyncClient['queueReview']>[0]): string | undefined => {
    if (!sync) return undefined
    try {
      setClientError(null)
      return sync.queueReview(commit)
    } catch (cause) {
      setClientError(cause instanceof Error ? cause.message : 'Review could not be placed in the sync queue')
      return undefined
    }
  }, [sync])

  const subscribeCards = useCallback((
    listener: Parameters<ConnectedSyncClient['subscribeCards']>[0],
    onError: Parameters<ConnectedSyncClient['subscribeCards']>[1],
  ) => sync ? sync.subscribeCards(listener, onError) : () => undefined, [sync])

  const subscribePuzzles = useCallback((
    listener: Parameters<ConnectedSyncClient['subscribePuzzleProgress']>[0],
    onError: Parameters<ConnectedSyncClient['subscribePuzzleProgress']>[1],
  ) => sync ? sync.subscribePuzzleProgress(listener, onError) : () => undefined, [sync])

  const commitPuzzle = useCallback(async (event: PuzzleAttemptEventV1): Promise<void> => {
    if (!sync) throw new Error('Cloud puzzle sync is unavailable')
    try {
      setClientError(null)
      sync.queuePuzzleAttempt({
        attemptId: event.eventId,
        puzzleId: event.puzzleId,
        outcome: event.outcome,
        incorrectAttempts: event.incorrectAttempts,
        usedHint: event.usedHint,
        occurredAt: event.occurredAt,
        ...(event.elapsedMs === undefined ? {} : { elapsedMs: event.elapsedMs }),
      })
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Puzzle attempt could not be placed in the sync queue')
      setClientError(error.message)
      throw error
    }
  }, [sync])

  if (sessionStatus === 'loading') {
    return <main id="main-content" className="startup-state"><div className="resource-state loading-state" role="status"><span className="spinner" aria-hidden="true" /><p>Checking your private session…</p></div></main>
  }

  const account = (
    <AccountControl
      auth={auth}
      session={session}
      sync={sync}
      syncState={syncState}
      queuedFamilyCount={familyPendingCount}
      {...(familyTrainingJournal ? { onRetryFamily: async () => {
        await familyTrainingJournal.flush()
        setClientError(null)
      } } : {})}
      {...(sync ? { onExportQueued: () => sync.exportUnsynced(familyTrainingJournal?.exportPendingRecords()) } : {})}
      onSession={(next) => { setSession(next); setSessionStatus('ready'); setSessionError(null) }}
    />
  )

  return (
    <>
      {sessionStatus === 'error' ? (
        <div className="global-storage-warning error-warning" role="alert">
          <span className="storage-message"><strong>Account service:</strong> {sessionError}. Offline study remains available.</span>
        </div>
      ) : null}
      <App
        dataSource={dataSource}
        repositorySelector={repositorySelector}
        accountControl={account}
        {...(familyTrainingJournal ? { familyTrainingJournal } : {})}
        {...(puzzleProgressRepository ? { puzzleProgressRepository } : {})}
        {...(sync ? {
          onReviewCommit: commitReview,
          onTacticalPuzzleAttempt: commitPuzzle,
          subscribeProgressCards: subscribeCards,
          subscribePuzzleProgress: subscribePuzzles,
        } : {})}
      />
      {syncState || clientError ? (
        <div className="hosted-sync-strip" data-status={clientError ? 'error' : syncState?.status} role={clientError ? 'alert' : 'status'}>
          {clientError ?? syncState?.message}
        </div>
      ) : null}
    </>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('LineRecall root element is missing')
void dataSource.initialize().catch(() => undefined)
createRoot(container).render(<StrictMode><ErrorBoundary><HostedRoot /></ErrorBoundary></StrictMode>)
