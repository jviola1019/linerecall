import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { AuthSession } from './contracts.ts'
import { AuthService } from './auth-service.ts'
import { HttpProblem } from './http.ts'
import type { ConnectedSyncClient, SyncState } from './sync-client.ts'

export interface AccountControlProps {
  auth: AuthService
  session: AuthSession | null
  sync: ConnectedSyncClient | null
  syncState: SyncState | null
  queuedFamilyCount?: number
  onRetryFamily?: () => Promise<void>
  onExportQueued?: () => void
  onSession: (session: AuthSession | null) => void
}
function failureMessage(error: unknown): string {
  if (error instanceof HttpProblem && error.retryAfterSeconds) {
    return `${error.message} Try again in ${error.retryAfterSeconds} seconds.`
  }
  return error instanceof Error ? error.message : 'The account request could not be completed.'
}

export function AccountControl({
  auth, session, sync, syncState, queuedFamilyCount = 0, onRetryFamily, onExportQueued, onSession,
}: AccountControlProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [email, setEmail] = useState('')
  const [passkeyName, setPasskeyName] = useState('This device')
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const portal = dialogRef.current?.parentElement ?? null
    const background = [...document.body.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== portal)
      .map((element) => ({ element, inert: element.inert }))
    for (const item of background) item.element.inert = true
    queueMicrotask(() => closeRef.current?.focus())
    return () => {
      for (const item of background) item.element.inert = item.inert
    }
  }, [open])

  const close = (): void => {
    setOpen(false)
    queueMicrotask(() => triggerRef.current?.focus())
  }

  const dialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? [])]
    const first = controls[0]
    const last = controls.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await operation()
    } catch (cause) {
      setError(failureMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const dialog = open ? createPortal(
    <div className="hosted-dialog-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div
        ref={dialogRef}
        className="hosted-account-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hosted-account-title"
        aria-describedby="hosted-account-description"
        onKeyDown={dialogKeyDown}
      >
        <header className="hosted-dialog-heading">
          <div>
            <p className="eyebrow">Private account</p>
            <h2 id="hosted-account-title">{session ? 'Account & sync' : 'Sign in to sync'}</h2>
          </div>
          <button ref={closeRef} type="button" className="secondary-button" onClick={close} aria-label="Close account dialog">Close</button>
        </header>
        <p id="hosted-account-description" className="field-help">
          {session
            ? `Signed in as ${session.user.email}. Review events are append-only and schedules are derived by the server.`
            : 'Accounts are optional. Magic links expire after five minutes; passkeys remain on your device.'}
        </p>

        {error ? <p className="hosted-account-error" role="alert"><strong>Could not complete that request.</strong> {error}</p> : null}
        {notice ? <p className="hosted-account-notice" role="status">{notice}</p> : null}

        {!session ? (
          <div className="hosted-account-sections">
            <form onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                await auth.sendMagicLink(email)
                setNotice('If the address can receive a link, it will arrive shortly. This message is intentionally the same for every address.')
              })
            }}>
              <h3>Email magic link</h3>
              <label htmlFor="account-email">Email address</label>
              <input id="account-email" type="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => setEmail(event.currentTarget.value)} required />
              <button type="submit" disabled={busy}>Send five-minute link</button>
            </form>
            <section aria-labelledby="passkey-signin-title">
              <h3 id="passkey-signin-title">Passkey</h3>
              <p>Use a passkey already registered to your LineRecall account.</p>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => {
                void run(async () => {
                  const next = await auth.signInWithPasskey()
                  onSession(next)
                  setNotice('Signed in with your passkey.')
                })
              }}>Sign in with passkey</button>
            </section>
          </div>
        ) : (
          <div className="hosted-account-sections">
            <section aria-labelledby="sync-status-title">
              <h3 id="sync-status-title">Sync status</h3>
              <p role="status">{syncState?.message ?? 'Preparing cloud sync.'}</p>
              <div className="inline-controls">
                <button type="button" disabled={busy || !sync} onClick={() => {
                  void run(async () => {
                    await Promise.all([sync?.flush(), onRetryFamily?.()])
                    setNotice('Queued study data was offered to the sync service.')
                  })
                }}>Retry sync</button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!sync || sync.pendingCount + queuedFamilyCount === 0}
                  onClick={() => {
                    if (onExportQueued) onExportQueued()
                    else sync?.exportUnsynced()
                  }}
                >Export queued study data</button>
              </div>
            </section>
            <section aria-labelledby="add-passkey-title">
              <h3 id="add-passkey-title">Add a passkey</h3>
              <label htmlFor="passkey-name">Passkey name</label>
              <input id="passkey-name" maxLength={64} value={passkeyName} onChange={(event) => setPasskeyName(event.currentTarget.value)} />
              <button type="button" disabled={busy} onClick={() => {
                void run(async () => { await auth.addPasskey(passkeyName); setNotice('Passkey added to this account.') })
              }}>Register passkey</button>
            </section>
            <section aria-labelledby="lichess-connection-title">
              <h3 id="lichess-connection-title">Lichess connection</h3>
              <p>No OAuth scopes are requested. Raw PGN and opponent identity are not retained after private aggregation.</p>
              <div className="inline-controls">
                <button type="button" disabled={busy} onClick={() => {
                  void run(async () => { window.location.assign(await auth.startLichessConnection()) })
                }}>Connect Lichess</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => {
                  void run(async () => { await auth.disconnectLichess(); setNotice('Lichess token revoked and connection removed.') })
                }}>Disconnect</button>
              </div>
            </section>
            <section aria-labelledby="account-data-title">
              <h3 id="account-data-title">Your data</h3>
              <div className="inline-controls">
                <a className="button-link" href="/v1/account/export" download>Download account export</a>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => {
                  void run(async () => { await auth.signOut(); onSession(null); close() })
                }}>Sign out</button>
              </div>
              <label htmlFor="delete-confirmation">Type DELETE to permanently remove the account</label>
              <input id="delete-confirmation" autoComplete="off" maxLength={6} value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.currentTarget.value)} />
              <button type="button" className="danger-button" disabled={busy || deleteConfirmation !== 'DELETE'} onClick={() => {
                void run(async () => { await auth.deleteAccount(); onSession(null); close() })
              }}>Delete account</button>
            </section>
          </div>
        )}
      </div>
    </div>,
    document.body,
  ) : null

  return (
    <>
      <button ref={triggerRef} type="button" className="utility-button" onClick={() => setOpen(true)}>
        {session ? 'Account' : 'Sign in'}
      </button>
      {dialog}
    </>
  )
}
