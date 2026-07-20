import type { DataManifest, OpeningPartition, VerifiedLine } from '../../domain/opening-data.ts'
import { safeExternalReference } from '../../security/external-url.ts'
import { EvidenceTable } from './EvidenceTable.tsx'

type BrowsableLine = OpeningPartition['lines'][number]
type ProvenanceLine = BrowsableLine | VerifiedLine

function isVerifiedLine(line: ProvenanceLine): line is VerifiedLine {
  return 'trainedSide' in line
}

function number(value: number): string {
  return value.toLocaleString('en-US')
}

function engineScore(score: { kind: 'centipawn' | 'mate'; value: number }): string {
  return score.kind === 'centipawn' ? `${score.value} cp` : `mate ${score.value}`
}

function sourceLink(url: string, children: React.ReactNode): React.JSX.Element {
  return <a href={safeExternalReference(url)} target="_blank" rel="noopener noreferrer">{children}</a>
}

export function DataLicenses({ audit, selectedLine }: { audit: DataManifest; selectedLine: ProvenanceLine | null }): React.JSX.Element {
  const rejectedTotal = Object.values(audit.corpus.rejected).reduce((sum, value) => sum + value, 0)
  const provenance = selectedLine
    ? audit.provenance.find((entry) => entry.id === selectedLine.provenanceRef) ?? null
    : null
  return (
    <div className="documentation-view">
      <header className="documentation-header">
        <p className="eyebrow">Auditable by design</p>
        <h1>Data &amp; Licenses</h1>
        <p>
          These values are read from the checksum-validated release manifest. No game count, rate, engine result, or discrepancy is generated in the browser.
        </p>
        <span className={`eligibility-badge ${audit.releaseEligible ? 'eligible' : 'quarantined'}`}>
          <span aria-hidden="true">{audit.releaseEligible ? '✓' : '⊘'}</span>
          {audit.releaseEligible ? 'Embedded snapshot gates passed' : 'Embedded snapshot gates failed'}
        </span>
      </header>

      <aside className="inline-warning" aria-label="Connected data release status">
        <strong>Connected redesign status:</strong> This page audits the data currently embedded for offline study. Its pass does not clear the deeper connected packs. The compact v3 graph, complete Q2 club corpus, receipt-bound tactical-puzzle shard, and graph-level Stockfish/Scid campaigns remain separate hard gates.
      </aside>

      <section className="documentation-section" aria-labelledby="taxonomy-license-title">
        <h2 id="taxonomy-license-title">Opening taxonomy</h2>
        <dl className="audit-grid">
          <div><dt>Source</dt><dd>{sourceLink(audit.taxonomy.repositoryUrl, 'lichess-org/chess-openings')}</dd></div>
          <div><dt>License</dt><dd>CC0-1.0</dd></div>
          <div><dt>Pinned commit</dt><dd><code>{audit.taxonomy.commit}</code></dd></div>
          <div><dt>Coverage</dt><dd>{number(audit.taxonomy.totalLines)} rows across {number(audit.taxonomy.ecoCodeCount)} ECO codes</dd></div>
        </dl>
      </section>

      <section className="documentation-section" aria-labelledby="corpus-license-title">
        <h2 id="corpus-license-title">Backtest corpus</h2>
        <p>
          Official Lichess broadcast PGNs from {audit.corpus.startMonth} through {audit.corpus.cutoffMonth}. The derived snapshot remains under
          {' '}{sourceLink(audit.corpus.licenseUrl, audit.corpus.license)} attribution and share-alike terms.
        </p>
        <dl className="audit-grid prominent-audit-grid">
          <div><dt>Records seen</dt><dd>{number(audit.corpus.recordsSeen)}</dd></div>
          <div><dt>Accepted</dt><dd>{number(audit.corpus.accepted)}</dd></div>
          <div><dt>Rejected</dt><dd>{number(rejectedTotal)}</dd></div>
          <div><dt>Deduplicated</dt><dd>{number(audit.corpus.deduplicated)}</dd></div>
          <div><dt>Archives</dt><dd>{audit.corpus.archives.length}</dd></div>
          <div><dt>Pulled</dt><dd><time dateTime={audit.corpus.pulledAt}>{audit.corpus.pulledAt}</time></dd></div>
        </dl>
        <details>
          <summary>Rejection totals and filtering rules</summary>
          <div className="two-column-details">
            <div>
              <h3>Rejected by reason</h3>
              <dl className="compact-definition-list">
                {Object.entries(audit.corpus.rejected).sort(([left], [right]) => left.localeCompare(right, 'en')).map(([reason, count]) => (
                  <div key={reason}><dt>{reason.replaceAll('_', ' ')}</dt><dd>{number(count)}</dd></div>
                ))}
              </dl>
            </div>
            <div>
              <h3>Filtering</h3>
              <dl className="compact-definition-list">
                {Object.entries(audit.corpus.filtering).map(([rule, value]) => (
                  <div key={rule}><dt>{rule.replaceAll('_', ' ')}</dt><dd>{String(value)}</dd></div>
                ))}
              </dl>
            </div>
          </div>
        </details>
        <details>
          <summary>Archive URLs and SHA-256 checksums ({audit.corpus.archives.length})</summary>
          <div className="archive-list table-scroll" tabIndex={0} role="region" aria-label="Corpus archive checksums, horizontally scrollable">
            <table className="stats-table">
              <thead><tr><th scope="col">Month</th><th scope="col">Archive</th><th scope="col">SHA-256</th></tr></thead>
              <tbody>
                {audit.corpus.archives.map((archive) => (
                  <tr key={archive.month}>
                    <th scope="row">{archive.month}</th>
                    <td>{sourceLink(archive.url, 'PGN.zst')}</td>
                    <td><code>{archive.sha256}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
        <p className="license-notice">{audit.corpus.derivedDataNotice}</p>
      </section>

      <section className="documentation-section" aria-labelledby="engine-title">
        <h2 id="engine-title">Offline engine sanity-check</h2>
        <p>
          {sourceLink('https://stockfishchess.org/', audit.engine.name)} was used offline only under {audit.engine.license}; no engine binary or WASM ships in this app.
        </p>
        <dl className="audit-grid">
          <div><dt>Commit</dt><dd><code>{audit.engine.releaseCommit}</code></dd></div>
          <div><dt>Configuration</dt><dd>{audit.engine.threads} thread, {audit.engine.hashMb} MB hash, MultiPV {audit.engine.multiPv}, {number(audit.engine.nodes)} nodes</dd></div>
          <div><dt>Analyzed</dt><dd><time dateTime={audit.engine.analyzedAt}>{audit.engine.analyzedAt}</time></dd></div>
          <div><dt>Binary SHA-256</dt><dd><code>{audit.engine.binarySha256}</code></dd></div>
          {audit.engine.nnue.map((network) => <div key={network.role}><dt>{network.role} NNUE SHA-256</dt><dd><code>{network.sha256}</code></dd></div>)}
        </dl>
      </section>

      <section className="documentation-section" aria-labelledby="crosscheck-title">
        <h2 id="crosscheck-title">Independent Scid cross-check</h2>
        <p>
          The GPL-2.0-only Scid oracle was used during auditing and is not copied into the shipped snapshot. Base-ECO mismatches quarantine affected lines; naming differences remain visible in line metadata.
        </p>
        <dl className="audit-grid">
          <div><dt>Stratified lines sampled</dt><dd>{number(audit.crosscheck.sampled)}</dd></div>
          <div><dt>Discrepancies</dt><dd>{number(audit.crosscheck.discrepancies)}</dd></div>
          <div><dt>Oracle commit</dt><dd><code>{audit.crosscheck.repositoryCommit}</code></dd></div>
          <div><dt>Oracle content shipped</dt><dd>{audit.crosscheck.oracleContentShipped ? 'Yes' : 'No'}</dd></div>
        </dl>
        <details>
          <summary>Derived discrepancy index ({number(audit.crosscheck.discrepancyIndex.length)})</summary>
          <p className="field-help">
            This index contains LineRecall taxonomy identity and the derived comparison outcome only. Scid opening names, moves, and oracle entries are not shipped.
          </p>
          {audit.crosscheck.discrepancyIndex.length === 0 ? (
            <p>No discrepancies were recorded in the stratified sample.</p>
          ) : (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Independent cross-check discrepancy index, horizontally scrollable">
              <table className="stats-table">
                <caption>{number(audit.crosscheck.discrepancyIndex.length)} sampled lines with a derived discrepancy outcome</caption>
                <thead>
                  <tr><th scope="col">LineRecall opening</th><th scope="col">Line ID</th><th scope="col">Outcome</th><th scope="col">Quarantined</th></tr>
                </thead>
                <tbody>
                  {audit.crosscheck.discrepancyIndex.map((entry) => (
                    <tr key={entry.lineId}>
                      <th scope="row">{entry.taxonomyEco} · {entry.taxonomyName}</th>
                      <td><code>{entry.lineId}</code></td>
                      <td>{entry.status.replaceAll('_', ' ')}</td>
                      <td>{entry.quarantined ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      </section>

      <section className="documentation-section" aria-labelledby="snapshot-title">
        <h2 id="snapshot-title">Release snapshot</h2>
        <dl className="audit-grid prominent-audit-grid">
          <div><dt>Browsable lines</dt><dd>{number(audit.audit.browsableLines)}</dd></div>
          <div><dt>Verified side variants</dt><dd>{number(audit.audit.verifiedVariants)}</dd></div>
          <div><dt>Drillable variants</dt><dd>{number(audit.audit.drillableVariants)}</dd></div>
          <div><dt>Quarantined variants</dt><dd>{number(audit.audit.quarantinedVariants)}</dd></div>
          <div><dt>ECO partitions</dt><dd>{number(audit.audit.partitions)}</dd></div>
          <div><dt>Generated</dt><dd><time dateTime={audit.generatedAt}>{audit.generatedAt}</time></dd></div>
        </dl>
      </section>

      <section className="documentation-section" aria-labelledby="selected-provenance-title">
        <h2 id="selected-provenance-title">Selected-line provenance</h2>
        {!selectedLine || !provenance ? (
          <p>Select any opening line in the browser to inspect its source row, sample size, and available verification evidence.</p>
        ) : (
          <>
            <h3>
              {selectedLine.eco} · {selectedLine.name} · {isVerifiedLine(selectedLine) ? `train ${selectedLine.trainedSide}` : 'browsable taxonomy line'}
            </h3>
            <dl className="audit-grid">
              <div><dt>Terminal sample</dt><dd>{number(selectedLine.terminalSampleSize)}</dd></div>
              <div><dt>Taxonomy file and row</dt><dd>{provenance.taxonomy.sourceFile}:{provenance.taxonomy.sourceRow}</dd></div>
              <div><dt>Taxonomy pulled</dt><dd>{provenance.taxonomy.pulledAt}</dd></div>
              <div><dt>Taxonomy commit</dt><dd><code>{provenance.taxonomy.commit}</code></dd></div>
              <div><dt>Corpus reference</dt><dd><code>{provenance.corpusRef}</code></dd></div>
              <div><dt>Engine reference</dt><dd>{provenance.engineRef ? <code>{provenance.engineRef}</code> : 'Not selected for engine verification'}</dd></div>
              <div><dt>Independent cross-check</dt><dd>{isVerifiedLine(selectedLine) ? selectedLine.crosscheckStatus.replaceAll('_', ' ') : provenance.crosscheckRef ? <code>{provenance.crosscheckRef}</code> : 'Not sampled'}</dd></div>
              {isVerifiedLine(selectedLine) ? (
                <>
                  <div><dt>Drill eligible</dt><dd>{selectedLine.drillEligible ? 'Yes' : 'No'}</dd></div>
                  <div><dt>Quarantine reasons</dt><dd>{selectedLine.quarantineReasons.length > 0 ? selectedLine.quarantineReasons.join(' ') : 'None'}</dd></div>
                </>
              ) : (
                <>
                  <div><dt>Backtest threshold</dt><dd>{selectedLine.backtestEligible ? 'At least 500 terminal games' : 'Insufficient terminal sample'}</dd></div>
                  <div><dt>Verified variants</dt><dd>{selectedLine.verifiedVariantIds.length}</dd></div>
                </>
              )}
            </dl>
            {isVerifiedLine(selectedLine) ? (
              <details>
                <summary>{selectedLine.nodes.length} learner decision-node engine checks</summary>
                <div className="node-audit-list">
                  {selectedLine.nodes.map((node) => (
                    <article key={node.id}>
                      <h4>Ply {node.ply + 1}: {node.moves.find((move) => move.expected)?.san ?? node.expectedMoveUci}</h4>
                      <dl className="compact-definition-list">
                        <div><dt>EPD</dt><dd><code>{node.epd}</code></dd></div>
                        <div><dt>Best move</dt><dd>{node.engine.bestMoveUci}</dd></div>
                        <div><dt>Best score</dt><dd>{engineScore(node.engine.bestScore)}</dd></div>
                        <div><dt>Expected-move loss</dt><dd>{node.engine.expectedMoveCentipawnLoss} cp</dd></div>
                        <div><dt>Engine reference</dt><dd><code>{node.engine.engineRef}</code></dd></div>
                        <div><dt>Analyzed</dt><dd>{node.engine.analyzedAt}</dd></div>
                        <div><dt>Quarantined</dt><dd>{node.engine.quarantined ? node.engine.quarantineReasons.join(' ') : 'No'}</dd></div>
                      </dl>
                      <div className="table-scroll" tabIndex={0} role="region" aria-label={`Ply ${node.ply + 1} Stockfish MultiPV details, horizontally scrollable`}>
                        <table className="stats-table compact-table">
                          <caption>Stored Stockfish MultiPV analysis</caption>
                          <thead>
                            <tr><th scope="col">MultiPV</th><th scope="col">Depth / selective</th><th scope="col">Nodes</th><th scope="col">Score</th><th scope="col">Bound</th><th scope="col">Principal variation (UCI)</th></tr>
                          </thead>
                          <tbody>
                            {node.engine.topVariations.map((variation) => (
                              <tr key={variation.multipv}>
                                <th scope="row">{variation.multipv}</th>
                                <td>{variation.depth ?? 'Not reported'} / {variation.selectiveDepth ?? 'Not reported'}</td>
                                <td>{variation.nodes === null ? 'Not reported' : number(variation.nodes)}</td>
                                <td>{engineScore(variation.score)}</td>
                                <td>{variation.bound}</td>
                                <td><code>{variation.movesUci.join(' ')}</code></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </article>
                  ))}
                </div>
              </details>
            ) : (
              <details>
                <summary>Backtested terminal results for both training sides</summary>
                <EvidenceTable bands={selectedLine.terminalWhiteStats} caption="Terminal results from White's perspective" />
                <EvidenceTable bands={selectedLine.terminalBlackStats} caption="Terminal results from Black's perspective" />
                <p className="field-help">No learner decision-node engine checks are attached to this browsable-only selection.</p>
              </details>
            )}
          </>
        )}
      </section>

      <section className="documentation-section" aria-labelledby="interface-assets-title">
        <h2 id="interface-assets-title">Interface assets</h2>
        <p>Interface assets are bundled locally. The downloaded app makes no remote font or piece-image request.</p>
        <dl className="audit-grid">
          <div>
            <dt>Chess pieces</dt>
            <dd>{sourceLink('https://github.com/lichess-org/lila/tree/3b7f2811bfb0682932f40688fcfb5d5caf7aece3/public/piece/chessnut', 'Chessnut SVG set')}</dd>
          </div>
          <div><dt>Piece author / license</dt><dd>Alexis Luengas · Apache-2.0</dd></div>
          <div><dt>Piece integrity</dt><dd>12 pinned, SHA-256-verified, static-scanned SVG files</dd></div>
          <div><dt>Piece source commit</dt><dd><code>3b7f2811bfb0682932f40688fcfb5d5caf7aece3</code></dd></div>
          <div><dt>Interface type</dt><dd>Operating-system sans-serif and monospace stacks; no bundled or remote font files</dd></div>
        </dl>
        <p className="field-help">Full copyright notices and license texts are retained in the source bundle under docs/THIRD_PARTY_NOTICES.md and licenses/.</p>
      </section>

      <section className="documentation-section limitations-section" aria-labelledby="limitations-title">
        <h2 id="limitations-title">Known limitations</h2>
        <ul>
          <li>Broadcast games overrepresent stronger tournament players; lower rating bands may be sparse.</li>
          <li>Statistics describe this corpus and are not promises of future results.</li>
          <li>A cold hosted visit needs the hosting service; the self-contained downloaded HTML is the guaranteed offline form.</li>
          <li>Engineering evidence supports WCAG conformance work but is not legal certification. Trademark and legal representations require qualified review.</li>
        </ul>
      </section>
    </div>
  )
}
