import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { ScidCrosscheckInputSchema } from '../../src/data/verification/contracts.ts'
import { TaxonomyPartitionSchema, type NormalizedTaxonomyLine } from '../../src/data/taxonomy-schema.ts'

const EngineLineSchema = z.object({
  id: z.string().min(1),
  sourceLineId: z.string().min(1),
  eco: z.string().regex(/^[A-E][0-9]{2}$/u),
  name: z.string().min(1),
  trainedSide: z.enum(['white', 'black']),
  terminalSampleSize: z.number().int().nonnegative(),
  quarantined: z.boolean(),
}).passthrough()

const EngineReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  lines: z.array(EngineLineSchema),
}).passthrough()

function requiredArgument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing required argument ${name}`)
  return resolve(value)
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function loadTaxonomyLines(directory: string): Promise<Map<string, NormalizedTaxonomyLine>> {
  const partitionsDirectory = join(directory, 'partitions')
  const files = (await readdir(partitionsDirectory))
    .filter((name) => /^[A-E]\d{2}\.json$/u.test(name))
    .sort()
  if (files.length !== 500) throw new Error(`Expected 500 taxonomy partitions, found ${files.length}`)
  const lines = new Map<string, NormalizedTaxonomyLine>()
  for (const file of files) {
    const partition = TaxonomyPartitionSchema.parse(await readJson(join(partitionsDirectory, file)))
    for (const line of partition.lines) {
      if (lines.has(line.id)) throw new Error(`Duplicate taxonomy line ${line.id}`)
      lines.set(line.id, line)
    }
  }
  if (lines.size !== 3_790) throw new Error(`Expected 3,790 taxonomy lines, found ${lines.size}`)
  return lines
}

export async function buildCrosscheckInput(options: {
  taxonomyDirectory: string
  engineReportPath: string
  outputPath: string
}): Promise<{ selectedSourceLines: number; engineQuarantinedSourceLines: number }> {
  const [taxonomy, rawEngineReport] = await Promise.all([
    loadTaxonomyLines(options.taxonomyDirectory),
    readJson(options.engineReportPath),
  ])
  const engineReport = EngineReportSchema.parse(rawEngineReport)
  const variants = new Map<string, typeof engineReport.lines>()
  for (const line of engineReport.lines) {
    const source = taxonomy.get(line.sourceLineId)
    if (!source) throw new Error(`Engine report references unknown source line ${line.sourceLineId}`)
    if (source.eco !== line.eco || source.name !== line.name) {
      throw new Error(`Engine metadata does not match taxonomy for ${line.sourceLineId}`)
    }
    const existing = variants.get(line.sourceLineId) ?? []
    if (existing.some((candidate) => candidate.trainedSide === line.trainedSide)) {
      throw new Error(`Duplicate ${line.trainedSide} engine variant for ${line.sourceLineId}`)
    }
    existing.push(line)
    variants.set(line.sourceLineId, existing)
  }

  const lines = [...variants.entries()]
    .map(([sourceLineId, sourceVariants]) => {
      const source = taxonomy.get(sourceLineId)
      if (!source) throw new Error(`Missing taxonomy line ${sourceLineId}`)
      const allVariantsQuarantined = sourceVariants.every((variant) => variant.quarantined)
      return {
        id: source.id,
        eco: source.eco,
        name: source.name,
        drillEligible: sourceVariants.some((variant) => variant.terminalSampleSize >= 500),
        quarantined: allVariantsQuarantined,
        movesUci: source.uci,
      }
    })
    .sort((left, right) => left.eco.localeCompare(right.eco, 'en') || left.id.localeCompare(right.id, 'en'))

  const output = ScidCrosscheckInputSchema.parse({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    lines,
  })
  await mkdir(dirname(options.outputPath), { recursive: true })
  await writeFile(options.outputPath, `${JSON.stringify(output)}\n`, 'utf8')
  return {
    selectedSourceLines: output.lines.length,
    engineQuarantinedSourceLines: output.lines.filter((line) => line.quarantined).length,
  }
}

const result = await buildCrosscheckInput({
  taxonomyDirectory: requiredArgument('--taxonomy', 'data/generated/taxonomy'),
  engineReportPath: requiredArgument('--engine-report', 'data/generated/engine-analysis.json'),
  outputPath: requiredArgument('--output', 'data/generated/scid-input.json'),
})
process.stdout.write(
  `Prepared ${result.selectedSourceLines} source lines for Scid; ${result.engineQuarantinedSourceLines} are excluded by engine quarantine.\n`,
)
