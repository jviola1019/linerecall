export interface ObjectStore {
  putPrivateImmutable(input: {
    key: string
    body: Uint8Array
    contentType: string
    sha256Hex: string
  }): Promise<void>
  deletePrivate(key: string): Promise<void>
}

export interface ComputeExecutor {
  submit(input: { jobId: string; workload: 'pgn-import' | 'stockfish' | 'scid' | 'data-refresh'; objectKey: string }): Promise<string>
}

export interface TelemetryExporter {
  recordOperationalMetric(name: string, value: number, attributes: Readonly<Record<string, string>>): void
}
