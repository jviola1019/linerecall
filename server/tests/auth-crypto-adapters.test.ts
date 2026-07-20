import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { DecryptCommand, EncryptCommand, type KMSClient } from '@aws-sdk/client-kms'
import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2'
import {
  createAuthenticatorAdapter,
  createBetterAuthGateway,
  RejectingMagicLinkSender,
} from '../src/auth/better-auth.js'
import { SesMagicLinkSender } from '../src/auth/ses-magic-link-sender.js'
import { KmsTokenVault } from '../src/connections/kms-token-vault.js'

describe('authentication and provider secret adapters', () => {
  it('requires a long auth secret before initializing the database adapter', () => {
    const base = {
      pool: {} as never,
      baseURL: 'https://api.example.test',
      publicOrigin: 'https://app.example.test',
      rpID: 'app.example.test',
      rpName: 'LineRecall',
      sender: new RejectingMagicLinkSender(),
      production: true,
      deleteUserData: async () => undefined,
    }
    assert.throws(() => createBetterAuthGateway({ ...base, secret: 'too-short' }), /at least 32 UTF-8 bytes/)
    assert.throws(() => createBetterAuthGateway({ ...base, secret: 'é'.repeat(15) }), /at least 32 UTF-8 bytes/)
  })

  it('keeps an unconfigured magic-link deployment fail closed', async () => {
    await assert.rejects(() => new RejectingMagicLinkSender().send(), /not configured/)
  })

  it('adapts provider sessions without leaking provider-specific state', async () => {
    const receivedHeaders: Headers[] = []
    const deletedHeaders: Headers[] = []
    let hasSession = false
    const runtime = {
      api: {
        async getSession({ headers }: { headers: Headers }) {
          receivedHeaders.push(headers)
          return hasSession ? {
            user: { id: 'user-1' },
            session: { id: 'session-1', createdAt: '2026-07-16T12:00:00.000Z' },
          } : null
        },
        async deleteUser({ headers }: { headers: Headers; body: Record<string, never> }) {
          deletedHeaders.push(headers)
        },
      },
      async handler(request: Request) {
        return new Response(request.method, { status: 202 })
      },
    }
    const gateway = createAuthenticatorAdapter(runtime)

    assert.equal(await gateway.authenticate({ authorization: undefined }), null)
    hasSession = true
    const actor = await gateway.authenticate({
      cookie: ['session=one', 'continuation=two'],
      'x-request-id': 'request-1',
      'x-ignored': undefined,
    })
    assert.deepEqual(actor, {
      userId: 'user-1',
      sessionId: 'session-1',
      authTime: new Date('2026-07-16T12:00:00.000Z'),
    })
    assert.equal(receivedHeaders[1]?.get('cookie'), 'session=one; continuation=two')
    assert.equal(receivedHeaders[1]?.get('x-request-id'), 'request-1')
    assert.equal(receivedHeaders[1]?.has('x-ignored'), false)

    const response = await gateway.handleWebRequest!(new Request('https://api.example.test/api/auth/session', { method: 'POST' }))
    assert.equal(response.status, 202)
    assert.equal(await response.text(), 'POST')
    await gateway.deleteIdentity!({ cookie: 'session=one' })
    assert.equal(deletedHeaders[0]?.get('cookie'), 'session=one')
  })

  it('sends a plain-text HTTPS magic link through SES without remote content', async () => {
    const commands: SendEmailCommand[] = []
    const client = {
      send: async (command: SendEmailCommand) => {
        commands.push(command)
        return { MessageId: 'message-1' }
      },
    } as unknown as SESv2Client
    const sender = new SesMagicLinkSender(client, 'signin@linerecall.example')
    await sender.send({
      email: 'learner@example.test',
      url: 'https://app.example.test/api/auth/magic-link/verify?token=opaque',
      expiresInSeconds: 300,
    })

    assert.equal(commands.length, 1)
    assert.ok(commands[0] instanceof SendEmailCommand)
    const input = commands[0]!.input
    assert.deepEqual(input.Destination?.ToAddresses, ['learner@example.test'])
    assert.equal(input.FromEmailAddress, 'signin@linerecall.example')
    const text = input.Content?.Simple?.Body?.Text?.Data ?? ''
    assert.match(text, /one-time link/u)
    assert.match(text, /expires in 5 minutes/u)
    assert.match(text, /^((?!<html|<script|https?:\/\/[^\s]*@).)*$/su)
  })

  it('rejects malformed senders and non-HTTPS production links while allowing loopback development', async () => {
    const client = { send: async () => ({}) } as unknown as SESv2Client
    assert.throws(() => new SesMagicLinkSender(client, 'not-a-mailbox'), /valid mailbox/)
    const sender = new SesMagicLinkSender(client, 'signin@example.test')
    await assert.rejects(
      () => sender.send({ email: 'user@example.test', url: 'http://evil.example/link', expiresInSeconds: 300 }),
      /non-HTTPS production magic link/,
    )
    await sender.send({ email: 'user@example.test', url: 'http://127.0.0.1:3000/link', expiresInSeconds: 60 })
    await sender.send({ email: 'user@example.test', url: 'http://localhost:3000/link', expiresInSeconds: 60 })
  })

  it('binds encrypted provider tokens to a pseudonymous KMS encryption context', async () => {
    const commands: Array<EncryptCommand | DecryptCommand> = []
    const client = {
      send: async (command: EncryptCommand | DecryptCommand) => {
        commands.push(command)
        if (command instanceof EncryptCommand) return { CiphertextBlob: new Uint8Array([9, 8, 7]) }
        return { Plaintext: Buffer.from('provider-token', 'utf8') }
      },
    } as unknown as KMSClient
    const vault = new KmsTokenVault(client, 'arn:aws:kms:region:account:key/key-id')
    const sealed = await vault.seal('private-user-id', 'provider-token')
    const opened = await vault.open('private-user-id', sealed)

    assert.deepEqual(sealed, new Uint8Array([9, 8, 7]))
    assert.equal(opened, 'provider-token')
    const expectedSubject = createHash('sha256').update('private-user-id').digest('hex')
    const encrypt = (commands[0] as EncryptCommand).input
    const decrypt = (commands[1] as DecryptCommand).input
    assert.equal(encrypt.KeyId, 'arn:aws:kms:region:account:key/key-id')
    assert.deepEqual(encrypt.EncryptionContext, {
      purpose: 'linerecall-provider-token-v1', subject: expectedSubject,
    })
    assert.deepEqual(decrypt.EncryptionContext, encrypt.EncryptionContext)
    assert.equal(JSON.stringify(encrypt.EncryptionContext).includes('private-user-id'), false)
  })

  it('rejects empty KMS encrypt and decrypt responses', async () => {
    const missingCiphertext = new KmsTokenVault({ send: async () => ({}) } as unknown as KMSClient, 'key')
    await assert.rejects(() => missingCiphertext.seal('user', 'token'), /no ciphertext/)
    const missingPlaintext = new KmsTokenVault({
      send: async (command: EncryptCommand | DecryptCommand) => command instanceof EncryptCommand
        ? { CiphertextBlob: new Uint8Array([1]) } : {},
    } as unknown as KMSClient, 'key')
    await assert.rejects(() => missingPlaintext.open('user', new Uint8Array([1])), /no plaintext/)
  })
})
