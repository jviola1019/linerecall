export function LoadingState({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="resource-state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  )
}

export function EmptyState({ title, detail }: { title: string; detail: string }): React.JSX.Element {
  return (
    <div className="resource-state empty-state">
      <span className="state-icon" aria-hidden="true">○</span>
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  )
}

export function ErrorState({
  title,
  detail,
  onRetry,
}: {
  title: string
  detail: string
  onRetry?: () => void
}): React.JSX.Element {
  return (
    <div className="resource-state error-state" role="alert">
      <span className="state-icon" aria-hidden="true">!</span>
      <h2>{title}</h2>
      <p>{detail}</p>
      {onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
    </div>
  )
}
