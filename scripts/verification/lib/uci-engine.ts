import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { join } from 'node:path';

import type { EnginePrincipalVariation, UciScore } from '../../../src/data/verification/contracts.ts';
import { sha256File } from './files.ts';

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/u;
export const UCI_INDEPENDENT_ROOT_RESET_COMMANDS = Object.freeze([
  'setoption name Clear Hash',
  'ucinewgame',
] as const);

interface PendingRequest {
  lines: string[];
  terminal: (line: string) => boolean;
  resolve: (lines: string[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface UciIdentity {
  name: string;
  author: string | null;
  optionDefaults: Record<string, string | null>;
}

export interface UciAnalysis {
  bestMoveUci: string;
  variations: EnginePrincipalVariation[];
}

function integerAfter(tokens: string[], keyword: string): number | null {
  const index = tokens.indexOf(keyword);
  if (index === -1) return null;
  const value = Number(tokens[index + 1]);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseUciInfo(line: string): EnginePrincipalVariation | null {
  if (!line.startsWith('info ')) return null;
  const tokens = line.trim().split(/\s+/u);
  const scoreIndex = tokens.indexOf('score');
  const pvIndex = tokens.indexOf('pv');
  if (scoreIndex === -1 || pvIndex === -1 || pvIndex <= scoreIndex + 2) return null;

  const scoreKind = tokens[scoreIndex + 1];
  const scoreValue = Number(tokens[scoreIndex + 2]);
  if (!Number.isSafeInteger(scoreValue) || (scoreKind !== 'cp' && scoreKind !== 'mate')) return null;
  const score: UciScore =
    scoreKind === 'cp'
      ? { kind: 'centipawn', value: scoreValue }
      : { kind: 'mate', value: scoreValue };
  const pv = tokens.slice(pvIndex + 1);
  if (pv.length === 0 || pv.some((move) => !UCI_MOVE.test(move))) return null;

  return {
    multipv: integerAfter(tokens, 'multipv') ?? 1,
    depth: integerAfter(tokens, 'depth'),
    selectiveDepth: integerAfter(tokens, 'seldepth'),
    nodes: integerAfter(tokens, 'nodes'),
    score,
    bound: tokens.includes('lowerbound') ? 'lower' : tokens.includes('upperbound') ? 'upper' : 'exact',
    movesUci: pv,
  };
}

export function latestUciVariations(lines: readonly string[]): EnginePrincipalVariation[] {
  const latestByMultiPv = new Map<number, EnginePrincipalVariation>();
  for (const line of lines) {
    const parsed = parseUciInfo(line);
    if (parsed === null) continue;
    const existing = latestByMultiPv.get(parsed.multipv);
    if (parsed.bound === 'exact' || existing === undefined || existing.bound !== 'exact') {
      latestByMultiPv.set(parsed.multipv, parsed);
    }
  }
  return [...latestByMultiPv.values()].sort((left, right) => left.multipv - right.multipv);
}

function parseOptionDefault(line: string): { name: string; value: string | null } | null {
  const match = /^option name (.+?) type (?:button|check|spin|string|combo)(?: default (.*?))?(?= min | max | var |$)/u.exec(
    line,
  );
  if (match?.[1] === undefined) return null;
  return { name: match[1], value: match[2] ?? null };
}

export class UciEngine {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: ReadlineInterface;
  readonly #stderr: string[] = [];
  #pending: PendingRequest | null = null;
  #closed = false;

  private constructor(
    executablePath: string,
    readonly workingDirectory: string,
  ) {
    this.#child = spawn(executablePath, [], {
      cwd: workingDirectory,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stdin.setDefaultEncoding('utf8');
    this.#child.stdin.on('error', (error) => this.#failPending(error));
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk: string) => {
      this.#stderr.push(chunk);
      if (this.#stderr.length > 100) this.#stderr.shift();
    });
    this.#lines = createInterface({ input: this.#child.stdout });
    this.#lines.on('line', (line) => this.#receiveLine(line.trimEnd()));
    this.#child.once('error', (error) => this.#failPending(error));
    this.#child.once('close', (code, signal) => {
      this.#closed = true;
      this.#failPending(
        new Error(
          `Stockfish exited before completing a UCI request (code=${String(code)}, signal=${String(signal)}): ${this.#stderr.join('').trim()}`,
        ),
      );
    });
  }

  static async start(options: {
    executablePath: string;
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<{ engine: UciEngine; identity: UciIdentity }> {
    const engine = new UciEngine(options.executablePath, options.workingDirectory);
    try {
      const lines = await engine.#request('uci', (line) => line === 'uciok', options.timeoutMs ?? 30_000);
      const name = lines.find((line) => line.startsWith('id name '))?.slice('id name '.length).trim();
      if (name === undefined || name === '') throw new Error('UCI engine did not identify itself');
      const author = lines.find((line) => line.startsWith('id author '))?.slice('id author '.length).trim() ?? null;
      const optionDefaults: Record<string, string | null> = {};
      for (const line of lines) {
        const option = parseOptionDefault(line);
        if (option !== null) optionDefaults[option.name] = option.value;
      }
      engine.#send('setoption name Threads value 1');
      engine.#send('setoption name Hash value 128');
      engine.#send('setoption name MultiPV value 5');
      await engine.#request('isready', (line) => line === 'readyok', options.timeoutMs ?? 30_000);
      engine.#send('ucinewgame');
      await engine.#request('isready', (line) => line === 'readyok', options.timeoutMs ?? 30_000);
      return { engine, identity: { name, author, optionDefaults } };
    } catch (error) {
      await engine.close();
      throw error;
    }
  }

  async exportNetworkHashes(timeoutMs = 60_000): Promise<
    Array<{ role: 'big' | 'small'; path: string; sha256: string }>
  > {
    const big = { role: 'big' as const, path: join(this.workingDirectory, 'stockfish-network-big.nnue') };
    const small = {
      role: 'small' as const,
      path: join(this.workingDirectory, 'stockfish-network-small.nnue'),
    };
    const paths = [big, small];
    this.#send(
      `export_net ${big.path.split(/[\\/]/u).at(-1)} ${small.path.split(/[\\/]/u).at(-1)}`,
    );
    await this.#request('isready', (line) => line === 'readyok', timeoutMs);
    return Promise.all(
      paths.map(async (network) => ({ ...network, sha256: await sha256File(network.path) })),
    );
  }

  setMultiPv(value: 1 | 5): void {
    this.#send(`setoption name MultiPV value ${value}`);
  }

  /** Clear all position-dependent state before an independent root search. */
  async resetForPosition(timeoutMs = 30_000): Promise<void> {
    for (const command of UCI_INDEPENDENT_ROOT_RESET_COMMANDS) this.#send(command);
    await this.#request('isready', (line) => line === 'readyok', timeoutMs);
  }

  async analyze(options: {
    fen: string;
    nodes: 250000;
    searchMoveUci?: string;
    timeoutMs?: number;
  }): Promise<UciAnalysis> {
    if (/\r|\n|\0/u.test(options.fen)) throw new Error('FEN contains a forbidden control character');
    if (options.searchMoveUci !== undefined && !UCI_MOVE.test(options.searchMoveUci)) {
      throw new Error(`Invalid UCI search move: ${options.searchMoveUci}`);
    }
    this.#send(`position fen ${options.fen}`);
    const searchMoves = options.searchMoveUci === undefined ? '' : ` searchmoves ${options.searchMoveUci}`;
    const lines = await this.#request(
      `go nodes ${options.nodes}${searchMoves}`,
      (line) => line.startsWith('bestmove '),
      options.timeoutMs ?? 120_000,
    );
    let bestMoveLine: string | undefined;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line?.startsWith('bestmove ')) {
        bestMoveLine = line;
        break;
      }
    }
    const bestMoveUci = bestMoveLine?.split(/\s+/u)[1];
    if (bestMoveUci === undefined || !UCI_MOVE.test(bestMoveUci)) {
      throw new Error(`Engine did not return a legal-looking best move: ${bestMoveLine ?? '(missing)'}`);
    }

    const variations = latestUciVariations(lines);
    if (variations.length === 0) throw new Error('Engine returned no scored principal variation');
    return { bestMoveUci, variations };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      this.#send('quit');
    } catch {
      this.#child.kill();
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#child.kill();
        resolve();
      }, 2_000);
      this.#child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.#lines.close();
  }

  #send(command: string): void {
    if (this.#closed) throw new Error('Cannot send a command to a closed UCI engine');
    if (/\r|\n|\0/u.test(command)) throw new Error('UCI command contains a forbidden control character');
    if (this.#child.stdin.destroyed || !this.#child.stdin.writable) {
      throw new Error('Stockfish stdin is not writable');
    }
    this.#child.stdin.write(`${command}\n`);
  }

  #request(command: string, terminal: (line: string) => boolean, timeoutMs: number): Promise<string[]> {
    if (this.#pending !== null) throw new Error('Concurrent UCI requests are not supported');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending = null;
        reject(new Error(`UCI command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
      this.#pending = { lines: [], terminal, resolve, reject, timer };
      this.#send(command);
    });
  }

  #receiveLine(line: string): void {
    const pending = this.#pending;
    if (pending === null) return;
    pending.lines.push(line);
    if (!pending.terminal(line)) return;
    clearTimeout(pending.timer);
    this.#pending = null;
    pending.resolve(pending.lines);
  }

  #failPending(error: Error): void {
    const pending = this.#pending;
    if (pending === null) return;
    clearTimeout(pending.timer);
    this.#pending = null;
    pending.reject(error);
  }
}
