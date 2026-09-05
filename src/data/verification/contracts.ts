import { z } from 'zod';

export const STOCKFISH_ANALYSIS_CONFIGURATION = Object.freeze({
  threads: 1,
  hashMb: 128,
  multiPv: 5,
  nodes: 250_000,
  maximumLinesPerEco: 3,
  minimumTerminalSampleSize: 500,
  independentlyAnalyzedAlternativeMinimumSampleSize: 100,
  playableMaximumCentipawnLoss: 50,
  inaccuracyMaximumCentipawnLoss: 99,
  quarantineCentipawnLoss: 100,
});

export const UciMoveSchema = z
  .string()
  .regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/, 'Expected a UCI move such as e2e4 or e7e8q');

export const EcoCodeSchema = z.string().regex(/^[A-E][0-9]{2}$/, 'Expected a base ECO code A00-E99');

export const CandidateMoveSchema = z
  .object({
    moveUci: UciMoveSchema,
    sampleSize: z.number().int().nonnegative(),
    acceptedBookTransposition: z.boolean().default(false),
  })
  .strict();

export const DecisionNodeSchema = z
  .object({
    id: z.string().min(1).max(200),
    fen: z.string().min(1).max(128),
    expectedMoveUci: UciMoveSchema,
    candidateMoves: z.array(CandidateMoveSchema).max(128),
  })
  .strict();

export const VerificationLineSchema = z
  .object({
    id: z.string().min(1).max(200),
    sourceLineId: z.string().min(1).max(200).optional(),
    eco: EcoCodeSchema,
    name: z.string().min(1).max(300),
    trainedSide: z.enum(['white', 'black']),
    terminalSampleSize: z.number().int().nonnegative(),
    drillEligible: z.boolean(),
    preexistingQuarantineReasons: z.array(z.string().min(1).max(500)).default([]),
    decisionNodes: z.array(DecisionNodeSchema).min(1).max(256),
  })
  .strict();

export const EngineAnalysisInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    lines: z.array(VerificationLineSchema),
  })
  .strict();

const CrosscheckLineSchemaBase = z.object({
  id: z.string().min(1).max(200),
  eco: EcoCodeSchema,
  name: z.string().min(1).max(300),
  drillEligible: z.boolean(),
  quarantined: z.boolean().default(false),
});

export const CrosscheckLineSchema = z.union([
  CrosscheckLineSchemaBase.extend({
    movesSan: z.array(z.string().min(1).max(32)).min(1).max(200),
    movesUci: z.never().optional(),
  }).strict(),
  CrosscheckLineSchemaBase.extend({
    movesUci: z.array(UciMoveSchema).min(1).max(200),
    movesSan: z.never().optional(),
  }).strict(),
]);

export const ScidCrosscheckInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    lines: z.array(CrosscheckLineSchema),
  })
  .strict();

export type CandidateMoveInput = z.infer<typeof CandidateMoveSchema>;
export type DecisionNodeInput = z.infer<typeof DecisionNodeSchema>;
export type VerificationLineInput = z.infer<typeof VerificationLineSchema>;
export type EngineAnalysisInput = z.infer<typeof EngineAnalysisInputSchema>;
export type CrosscheckLineInput = z.infer<typeof CrosscheckLineSchema>;
export type ScidCrosscheckInput = z.infer<typeof ScidCrosscheckInputSchema>;

export type UciScore =
  | { kind: 'centipawn'; value: number }
  | { kind: 'mate'; value: number };

export type MoveClassification =
  | 'book'
  | 'playable'
  | 'inaccuracy'
  | 'mistake'
  | 'unverified_deviation';

export interface EnginePrincipalVariation {
  multipv: number;
  depth: number | null;
  selectiveDepth: number | null;
  nodes: number | null;
  score: UciScore;
  bound: 'exact' | 'lower' | 'upper';
  movesUci: string[];
}

export interface EngineCheck {
  engineName: string;
  engineAuthor: string | null;
  engineBinarySha256: string;
  nnue: Array<{
    role: 'big' | 'small';
    defaultFileName: string | null;
    sha256: string;
  }>;
  releaseCommit: string;
  threads: 1;
  hashMb: 128;
  multiPv: 5;
  nodes: 250000;
  analyzedAt: string;
}
