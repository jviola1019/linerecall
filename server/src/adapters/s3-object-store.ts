import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3'
import type { ObjectStore } from '../infrastructure/ports.js'

const MAXIMUM_VERSIONS_PER_PRIVATE_KEY = 10_000

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly kmsKeyId: string,
  ) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid private object-store bucket name')
  }

  async putPrivateImmutable(input: { key: string; body: Uint8Array; contentType: string; sha256Hex: string }): Promise<void> {
    if (!/^private\/[a-zA-Z0-9/_-]{1,900}$/.test(input.key) || input.key.includes('//')) throw new Error('Invalid private object key')
    if (!/^[a-f0-9]{64}$/.test(input.sha256Hex)) throw new Error('Invalid SHA-256 digest')
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ChecksumSHA256: Buffer.from(input.sha256Hex, 'hex').toString('base64'),
      Metadata: { sha256: input.sha256Hex },
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: this.kmsKeyId,
      BucketKeyEnabled: true,
      IfNoneMatch: '*',
    }))
  }

  async deletePrivate(key: string): Promise<void> {
    if (!/^private\/[a-zA-Z0-9/_-]{1,900}$/.test(key) || key.includes('//')) throw new Error('Invalid private object key')
    const versions = await this.#versionsForExactKey(key)
    if (versions.length === 0) {
      // This is the correct permanent delete for an unversioned deployment and
      // is also idempotent when the key never existed.
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      return
    }
    for (let offset = 0; offset < versions.length; offset += 1_000) {
      const response = await this.client.send(new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: versions.slice(offset, offset + 1_000), Quiet: true },
      }))
      if (response.Errors?.length) throw new Error('Private object version deletion was not fully acknowledged')
    }
    if ((await this.#versionsForExactKey(key)).length !== 0) {
      throw new Error('Private object versions remain after deletion')
    }
  }

  async #versionsForExactKey(key: string): Promise<ObjectIdentifier[]> {
    const found: ObjectIdentifier[] = []
    let keyMarker: string | undefined
    let versionIdMarker: string | undefined
    const cursors = new Set<string>()
    do {
      const response = await this.client.send(new ListObjectVersionsCommand({
        Bucket: this.bucket, Prefix: key, MaxKeys: 1_000, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker,
      }))
      for (const item of [...(response.Versions ?? []), ...(response.DeleteMarkers ?? [])]) {
        if (item.Key !== key || !item.VersionId) continue
        found.push({ Key: key, VersionId: item.VersionId })
        if (found.length > MAXIMUM_VERSIONS_PER_PRIVATE_KEY) {
          throw new Error('Private object has too many versions for bounded deletion')
        }
      }
      if (!response.IsTruncated) break
      if (!response.NextKeyMarker) throw new Error('Invalid object-version pagination cursor')
      const cursor = `${response.NextKeyMarker}\0${response.NextVersionIdMarker ?? ''}`
      if (cursors.has(cursor)) throw new Error('Repeated object-version pagination cursor')
      cursors.add(cursor)
      keyMarker = response.NextKeyMarker
      versionIdMarker = response.NextVersionIdMarker
    } while (true)
    return found
  }
}
