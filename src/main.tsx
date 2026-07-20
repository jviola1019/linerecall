import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import './app/styles.css'
import { EmbeddedOpeningDataSource } from './data/embedded-opening-data-source.ts'

interface ErrorBoundaryState {
  error: Error | null
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The app has no telemetry. Keep the diagnostic local for an inspecting developer.
    console.error('LineRecall render failure', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <main id="main-content" className="startup-state">
        <div className="resource-state error-state" role="alert">
          <span className="state-icon" aria-hidden="true">!</span>
          <h1>LineRecall could not continue</h1>
          <p>{this.state.error.message || 'An unexpected application error occurred.'}</p>
          <button type="button" onClick={() => window.location.reload()}>Reload the app</button>
          <p className="field-help">Reloading can discard session-only changes. Use progress export whenever the interface remains available.</p>
        </div>
      </main>
    )
  }
}

const container = document.getElementById('root')
if (!container) throw new Error('LineRecall root element is missing')

const dataSource = new EmbeddedOpeningDataSource()
// The static shell is parsed and operable before this module. Start the exact
// same cached integrity/schema-validation promise immediately so it can make
// progress while React mounts; App still owns all success/error UI handling.
// Attaching this rejection handler prevents a failed prewarm from becoming an
// unhandled rejection before App subscribes to the cached promise.
void dataSource.initialize().catch(() => undefined)
const mountApplication = (): void => {
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary>
        <App dataSource={dataSource} />
      </ErrorBoundary>
    </StrictMode>,
  )
}

// Let the self-contained preboot shell reach the screen before React replaces
// it. The following timer is queued from the first animation frame, so the
// browser paints the already-operable static controls before mounting the app.
if (typeof requestAnimationFrame === 'function') {
  requestAnimationFrame(() => setTimeout(mountApplication, 0))
} else {
  setTimeout(mountApplication, 0)
}
