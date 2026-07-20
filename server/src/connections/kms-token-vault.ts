import { createHash } from 'node:crypto'
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms'
import type { TokenVault } from './lichess.js'

export class KmsTokenVault implements TokenVault {
  constructor(private readonly client: KMSClient, private readonly keyId: string) {}

  #context(userId: string): Record<string, string> {
    return { purpose: 'linerecall-provider-token-v1', subject: createHash('sha256').update(userId).digest('hex') }
  }

  async seal(userId: string, plaintext: string): Promise<Uint8Array> {
    const result = await this.client.send(new EncryptCommand({
      KeyId: this.keyId,
      Plaintext: Buffer.from(plaintext, 'utf8'),
      EncryptionContext: this.#context(userId),
    }))
    if (!result.CiphertextBlob) throw new Error('KMS returned no ciphertext')
    return result.CiphertextBlob
  }

  async open(userId: string, ciphertext: Uint8Array): Promise<string> {
    const result = await this.client.send(new DecryptCommand({
      CiphertextBlob: ciphertext,
      EncryptionContext: this.#context(userId),
      KeyId: this.keyId,
    }))
    if (!result.Plaintext) throw new Error('KMS returned no plaintext')
    return Buffer.from(result.Plaintext).toString('utf8')
  }
}
