import type { BandStats, MoveEvidence } from '../../domain/opening-data.ts'

function rate(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}%`
}

function LowSampleWarning({ context = '' }: { context?: string }): React.JSX.Element {
  return (
    <span className="sample-warning" title="Low sample: fewer than 100 games">
      {' '}⚠ <span className="sr-only">low sample{context ? ` for ${context}` : ''}</span>
    </span>
  )
}

export interface EvidenceTableProps {
  bands: readonly BandStats[]
  caption: string
  compact?: boolean
}

export function EvidenceTable({ bands, caption, compact = false }: EvidenceTableProps): React.JSX.Element {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={`${caption}, horizontally scrollable`}>
      <table className={compact ? 'stats-table compact-table' : 'stats-table'}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Rating band</th>
            <th scope="col">Games</th>
            <th scope="col">Win</th>
            <th scope="col">Draw</th>
            <th scope="col">Loss</th>
          </tr>
        </thead>
        <tbody>
          {bands.map((band) => (
            <tr key={band.band}>
              <th scope="row">{band.band}</th>
              <td>{band.n.toLocaleString('en-US')}{band.lowSample ? <LowSampleWarning /> : null}</td>
              {band.n === 0 ? (
                <td colSpan={3}>No games</td>
              ) : (
                <>
                  <td>{rate(band.winRate)}</td>
                  <td>{rate(band.drawRate)}</td>
                  <td>{rate(band.lossRate)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function MoveComparison({ played, expected }: { played: MoveEvidence | null; expected: MoveEvidence }): React.JSX.Element {
  const rows = expected.bands.map((bookBand, index) => ({
    band: bookBand.band,
    played: played?.bands[index] ?? null,
    expected: bookBand,
  }))
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Played and book move comparison, horizontally scrollable">
      <table className="stats-table comparison-table">
        <caption>Historical results for your side by rating band</caption>
        <thead>
          <tr>
            <th rowSpan={2} scope="col">Rating</th>
            <th colSpan={2} scope="colgroup">Played: {played?.san ?? 'No verified evidence'}</th>
            <th colSpan={2} scope="colgroup">Book: {expected.san}</th>
          </tr>
          <tr>
            <th scope="col">N</th><th scope="col">W / D / L</th>
            <th scope="col">N</th><th scope="col">W / D / L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.band}>
              <th scope="row">{row.band}</th>
              <td>
                {row.played?.n.toLocaleString('en-US') ?? '—'}
                {row.played?.lowSample ? <LowSampleWarning context="played move" /> : null}
              </td>
              <td>{row.played && row.played.n > 0 ? `${rate(row.played.winRate)} / ${rate(row.played.drawRate)} / ${rate(row.played.lossRate)}` : 'No games'}</td>
              <td>
                {row.expected.n.toLocaleString('en-US')}
                {row.expected.lowSample ? <LowSampleWarning context="book move" /> : null}
              </td>
              <td>{row.expected.n > 0 ? `${rate(row.expected.winRate)} / ${rate(row.expected.drawRate)} / ${rate(row.expected.lossRate)}` : 'No games'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
