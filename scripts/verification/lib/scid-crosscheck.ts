import { createHash } from 'node:crypto';

import { Chess } from 'chess.js';

import type { CrosscheckLineInput } from '../../../src/data/verification/contracts.ts';

export interface ScidEcoEntry {
  code: string;
  baseEco: string;
  name: string;
  movesText: string;
  terminalEpd: string;
  plyCount: number;
  sourceLine: number;
}

export interface ScidParseFailure {
  code: string;
  name: string;
  sourceLine: number;
  reason: string;
}

export interface ParsedScidEco {
  entries: ScidEcoEntry[];
  failures: ScidParseFailure[];
}

export type CrosscheckStatus =
  | 'match'
  | 'naming_difference'
  | 'missing_oracle_entry'
  | 'base_eco_mismatch'
  | 'ambiguous_oracle_base';

export interface ScidLineCrosscheck {
  lineId: string;
  taxonomyEco: string;
  taxonomyName: string;
  status: CrosscheckStatus;
  quarantined: boolean;
  deepestMatchedPly: number | null;
  oracleBaseEcos: string[];
  oracleCodes: string[];
  oracleNames: string[];
}

export function normalizedEpd(fen: string): string {
  const fields = fen.trim().split(/\s+/u);
  if (fields.length !== 6) throw new Error(`Invalid FEN: ${fen}`);
  return fields.slice(0, 4).join(' ');
}

function decodeScidName(value: string): string {
  return value.replace(/\\(["\\])/gu, '$1');
}

export function parseScidEco(source: string): ParsedScidEco {
  const entries: ScidEcoEntry[] = [];
  const failures: ScidParseFailure[] = [];
  let current:
    | { code: string; name: string; sourceLine: number; moveFragments: string[] }
    | undefined;

  function finalize(): void {
    if (current === undefined) return;
    const record = current;
    current = undefined;
    const joined = record.moveFragments.join(' ').trim();
    const terminator = joined.indexOf('*');
    if (terminator === -1) {
      failures.push({ ...record, reason: 'Missing movetext terminator', sourceLine: record.sourceLine });
      return;
    }
    const movesText = `${joined.slice(0, terminator).trim()} *`;
    try {
      const chess = new Chess();
      chess.loadPgn(movesText, { strict: false });
      entries.push({
        code: record.code,
        baseEco: record.code.slice(0, 3),
        name: record.name,
        movesText,
        terminalEpd: normalizedEpd(chess.fen()),
        plyCount: chess.history().length,
        sourceLine: record.sourceLine,
      });
    } catch (error) {
      failures.push({
        code: record.code,
        name: record.name,
        sourceLine: record.sourceLine,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const lines = source.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const header = /^([A-E][0-9]{2}(?:[a-z][1-4]?)?)\s+"((?:[^"\\]|\\.)*)"\s*(.*)$/u.exec(
      trimmed,
    );
    if (header !== null) {
      finalize();
      current = {
        code: header[1] as string,
        name: decodeScidName(header[2] as string),
        sourceLine: index + 1,
        moveFragments: header[3] === '' ? [] : [header[3] as string],
      };
    } else if (current !== undefined) {
      current.moveFragments.push(trimmed);
    }
  }
  finalize();
  return { entries, failures };
}

function playLine(line: CrosscheckLineInput): string[] {
  const chess = new Chess();
  const positions: string[] = [];
  const usesSan = 'movesSan' in line && line.movesSan !== undefined;
  const moves = usesSan ? line.movesSan : line.movesUci;
  if (moves === undefined) throw new Error(`Line ${line.id} has no moves`);
  for (const [index, move] of moves.entries()) {
    try {
      if (usesSan) {
        chess.move(move, { strict: false });
      } else {
        const promotion = move[4];
        chess.move({
          from: move.slice(0, 2),
          to: move.slice(2, 4),
          ...(promotion === undefined ? {} : { promotion }),
        });
      }
    } catch (error) {
      throw new Error(
        `Invalid move ${move} at ply ${index + 1} for ${line.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    positions.push(normalizedEpd(chess.fen()));
  }
  return positions;
}

function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

export function buildScidPositionIndex(entries: ScidEcoEntry[]): Map<string, ScidEcoEntry[]> {
  const index = new Map<string, ScidEcoEntry[]>();
  for (const entry of entries) {
    const matches = index.get(entry.terminalEpd) ?? [];
    matches.push(entry);
    index.set(entry.terminalEpd, matches);
  }
  return index;
}

export function crosscheckLine(
  line: CrosscheckLineInput,
  positionIndex: Map<string, ScidEcoEntry[]>,
): ScidLineCrosscheck {
  const positions = playLine(line);
  let deepestMatchedPly: number | null = null;
  let matches: ScidEcoEntry[] = [];
  for (const [index, position] of positions.entries()) {
    const atPosition = positionIndex.get(position);
    if (atPosition !== undefined && atPosition.length > 0) {
      deepestMatchedPly = index + 1;
      matches = atPosition;
    }
  }

  const oracleBaseEcos = [...new Set(matches.map((entry) => entry.baseEco))].sort();
  const oracleCodes = [...new Set(matches.map((entry) => entry.code))].sort();
  const oracleNames = [...new Set(matches.map((entry) => entry.name))].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  let status: CrosscheckStatus;
  let quarantined = false;
  if (matches.length === 0) {
    status = 'missing_oracle_entry';
  } else if (oracleBaseEcos.length > 1) {
    status = 'ambiguous_oracle_base';
    quarantined = true;
  } else if (oracleBaseEcos[0] !== line.eco) {
    status = 'base_eco_mismatch';
    quarantined = true;
  } else if (oracleNames.some((name) => normalizeName(name) === normalizeName(line.name))) {
    status = 'match';
  } else {
    status = 'naming_difference';
  }
  return {
    lineId: line.id,
    taxonomyEco: line.eco,
    taxonomyName: line.name,
    status,
    quarantined,
    deepestMatchedPly,
    oracleBaseEcos,
    oracleCodes,
    oracleNames,
  };
}

function stableRank(seed: string, line: CrosscheckLineInput): string {
  return createHash('sha256').update(`${seed}\0${line.id}`, 'utf8').digest('hex');
}

export function selectStratifiedLines(
  lines: CrosscheckLineInput[],
  maximum: number,
  seed: string,
): CrosscheckLineInput[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 250) {
    throw new Error('Cross-check sample maximum must be an integer from 1 through 250');
  }
  const groups = new Map<string, CrosscheckLineInput[]>(
    ['A', 'B', 'C', 'D', 'E'].map((volume) => [volume, []]),
  );
  for (const line of lines) {
    if (!line.drillEligible || line.quarantined) continue;
    groups.get(line.eco[0] as string)?.push(line);
  }
  for (const group of groups.values()) {
    group.sort((left, right) =>
      stableRank(seed, left).localeCompare(stableRank(seed, right), 'en'),
    );
  }

  const selected: CrosscheckLineInput[] = [];
  let offset = 0;
  while (selected.length < maximum) {
    let added = false;
    for (const volume of ['A', 'B', 'C', 'D', 'E']) {
      const line = groups.get(volume)?.[offset];
      if (line !== undefined) {
        selected.push(line);
        added = true;
        if (selected.length === maximum) break;
      }
    }
    if (!added) break;
    offset += 1;
  }
  return selected;
}
