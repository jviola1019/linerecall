import type { PositionGraph, PositionGraphEdge } from '../domain/deviation.ts'
import type { WireSearchSnapshot } from './wire.ts'

function moveKey(epd: string, uci: string): string {
  return `${epd}\0${uci}`
}

function addEdge(map: Map<string, PositionGraphEdge[]>, key: string, edge: PositionGraphEdge): void {
  const edges = map.get(key) ?? []
  edges.push(edge)
  map.set(key, edges)
}

/**
 * Builds the global known-opening graph from the validated compact snapshot.
 * The wire index intentionally does not repeat successor EPD/ply data; those
 * fields remain null and are never used to switch a selected repertoire.
 */
export function positionGraphFromWire(
  search: WireSearchSnapshot,
): PositionGraph {
  const byPosition = new Map<string, PositionGraphEdge[]>()
  const byPositionMove = new Map<string, PositionGraphEdge[]>()
  for (const position of search.q) {
    const epd = position[0]
    for (const [uci, lineIndexes] of position[1]) {
      for (const lineIndex of lineIndexes) {
        const line = search.l[lineIndex]
        if (!line) throw new Error(`Book graph references unknown line index ${lineIndex}`)
        const edge: PositionGraphEdge = {
          lineId: line[0],
          sourceLineId: line[0],
          ply: null,
          beforeEpd: epd,
          moveUci: uci,
          afterEpd: null,
        }
        addEdge(byPosition, epd, edge)
        addEdge(byPositionMove, moveKey(epd, uci), edge)
      }
    }
  }
  const sort = (edges: PositionGraphEdge[]): void => {
    edges.sort((left, right) => left.lineId.localeCompare(right.lineId, 'en'))
  }
  for (const edges of byPosition.values()) sort(edges)
  for (const edges of byPositionMove.values()) sort(edges)
  return { edgesByPosition: byPosition, edgesByPositionMove: byPositionMove }
}
