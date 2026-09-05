import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { loadConfig } from '../src/config.js'
import { uuidV7 } from '../src/ids.js'
import { UUID_V7 } from '../src/contracts.js'

describe('configuration and identifiers', () => {
  it('creates RFC 9562 UUIDv7 identifiers', () => {
    const first = uuidV7(1_700_000_000_000)
    const second = uuidV7(1_700_000_000_001)
    assert.match(first, UUID_V7)
    assert.ok(first < second)
    for (const invalid of [-1, Number.MAX_SAFE_INTEGER, 1.5, Number.NaN]) {
      assert.throws(() => uuidV7(invalid), /Invalid UUIDv7 timestamp/)
    }
  })

  it('rejects accidental insecure production authentication', () => {
    assert.throws(() => loadConfig({
      NODE_ENV: 'production', AUTH_MODE: 'dev-header', ALLOW_INSECURE_DEV_AUTH: 'true',
      PUBLIC_ORIGIN: 'https://app.example.test', SERVICE_ORIGIN: 'https://api.example.test',
    }), /Production requires AUTH_MODE=better-auth/)
  })

  it('requires explicit opt-in for development header auth', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'development' }), /ALLOW_INSECURE_DEV_AUTH/)
    const config = loadConfig({ NODE_ENV: 'test', ALLOW_INSECURE_DEV_AUTH: 'true' })
    assert.equal(config.AUTH_MODE, 'dev-header')
    assert.equal(config.production, false)
  })

  it('accepts an explicit complete production configuration with inline verified CA', () => {
    const config = loadConfig({
      NODE_ENV: 'production', AUTH_MODE: 'better-auth', PUBLIC_ORIGIN: 'https://app.example.test', SERVICE_ORIGIN: 'https://api.example.test',
      TRUST_PROXY: 'true', PASSKEY_RP_ID: 'example.test',
      DATABASE_URL: 'postgresql://app@example.test/db', AUTH_DATABASE_URL: 'postgresql://auth@example.test/db',
      DATABASE_SSL_CA_PEM: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----', REDIS_URL: 'rediss://example.test',
      BETTER_AUTH_SECRET: '01234567890123456789012345678901', MAGIC_LINK_FROM: 'login@example.test',
      PRIVATE_OBJECT_BUCKET: 'private-example', PUBLIC_DATA_BUCKET: 'catalog-example', CATALOG_MANIFEST_KEY: 'public/manifests/current.json',
      CATALOG_SIGNING_PUBLIC_KEY_PEM: 'public-key', PRIVATE_BUCKET_KMS_KEY_ID: 'alias/app', BATCH_JOB_QUEUE: 'queue',
      BATCH_IMPORT_JOB_DEFINITION: 'import', BATCH_STOCKFISH_JOB_DEFINITION: 'stockfish', BATCH_SCID_JOB_DEFINITION: 'scid',
      BATCH_REFRESH_JOB_DEFINITION: 'refresh', LICHESS_CLIENT_ID: 'client-id', TOKEN_KMS_KEY_ID: 'alias/token',
      EXTERNAL_USER_AGENT: 'LineRecall security@example.test',
    })
    assert.equal(config.production, true)
    assert.equal(config.databaseSsl?.rejectUnauthorized, true)
  })

  it('rejects insecure production origins, Redis, proxy, and passkey identity', () => {
    const complete = {
      NODE_ENV: 'production', AUTH_MODE: 'better-auth', PUBLIC_ORIGIN: 'https://app.example.test', SERVICE_ORIGIN: 'https://api.example.test',
      TRUST_PROXY: 'true', PASSKEY_RP_ID: 'example.test', DATABASE_URL: 'postgresql://app@example.test/db',
      AUTH_DATABASE_URL: 'postgresql://auth@example.test/db', DATABASE_SSL_CA_PEM: 'test-ca', REDIS_URL: 'rediss://example.test',
      BETTER_AUTH_SECRET: '01234567890123456789012345678901', MAGIC_LINK_FROM: 'login@example.test',
      PRIVATE_OBJECT_BUCKET: 'private-example', PUBLIC_DATA_BUCKET: 'catalog-example', CATALOG_MANIFEST_KEY: 'public/manifests/current.json',
      CATALOG_SIGNING_PUBLIC_KEY_PEM: 'public-key', PRIVATE_BUCKET_KMS_KEY_ID: 'alias/app', BATCH_JOB_QUEUE: 'queue',
      BATCH_IMPORT_JOB_DEFINITION: 'import', BATCH_STOCKFISH_JOB_DEFINITION: 'stockfish', BATCH_SCID_JOB_DEFINITION: 'scid',
      BATCH_REFRESH_JOB_DEFINITION: 'refresh', LICHESS_CLIENT_ID: 'client-id', TOKEN_KMS_KEY_ID: 'alias/token',
      EXTERNAL_USER_AGENT: 'LineRecall security@example.test',
    }
    assert.throws(() => loadConfig({ ...complete, PUBLIC_ORIGIN: 'http://app.example.test' }), /must use HTTPS/)
    assert.throws(() => loadConfig({ ...complete, REDIS_URL: 'redis://example.test' }), /rediss/)
    assert.throws(() => loadConfig({ ...complete, TRUST_PROXY: 'false' }), /TRUST_PROXY/)
    assert.throws(() => loadConfig({ ...complete, PASSKEY_RP_ID: 'localhost' }), /PASSKEY_RP_ID/)
  })

  it('fails closed when Better Auth or production infrastructure requirements are incomplete', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'better-auth' }),
      /AUTH_DATABASE_URL is required for Better Auth/,
    )
    const complete = {
      NODE_ENV: 'production', AUTH_MODE: 'better-auth', PUBLIC_ORIGIN: 'https://app.example.test', SERVICE_ORIGIN: 'https://api.example.test',
      TRUST_PROXY: 'true', PASSKEY_RP_ID: 'example.test', DATABASE_URL: 'postgresql://app@example.test/db',
      AUTH_DATABASE_URL: 'postgresql://auth@example.test/db', DATABASE_SSL_CA_PEM: 'test-ca', REDIS_URL: 'rediss://example.test',
      BETTER_AUTH_SECRET: '01234567890123456789012345678901', MAGIC_LINK_FROM: 'login@example.test',
      PRIVATE_OBJECT_BUCKET: 'private-example', PUBLIC_DATA_BUCKET: 'catalog-example', CATALOG_MANIFEST_KEY: 'public/manifests/current.json',
      CATALOG_SIGNING_PUBLIC_KEY_PEM: 'public-key', PRIVATE_BUCKET_KMS_KEY_ID: 'alias/app', BATCH_JOB_QUEUE: 'queue',
      BATCH_IMPORT_JOB_DEFINITION: 'import', BATCH_STOCKFISH_JOB_DEFINITION: 'stockfish', BATCH_SCID_JOB_DEFINITION: 'scid',
      BATCH_REFRESH_JOB_DEFINITION: 'refresh', LICHESS_CLIENT_ID: 'client-id', TOKEN_KMS_KEY_ID: 'alias/token',
      EXTERNAL_USER_AGENT: 'LineRecall security@example.test',
    }
    assert.throws(() => loadConfig({ ...complete, REDIS_URL: undefined }), /Production requires REDIS_URL/)
    assert.throws(
      () => loadConfig({ ...complete, DATABASE_SSL_CA_PEM: undefined }),
      /Production requires DATABASE_SSL_CA_FILE or DATABASE_SSL_CA_PEM/,
    )
    assert.throws(() => loadConfig({ ...complete, PUBLIC_ORIGIN: 'https://app.example.test/path' }), /must not contain paths/)
    assert.throws(() => loadConfig({ ...complete, DATABASE_URL: undefined }), /DATABASE_URL is required in production/)
  })

  it('loads a configured PostgreSQL trust anchor from a file when inline PEM is absent', () => {
    const config = loadConfig({
      NODE_ENV: 'production', AUTH_MODE: 'better-auth', PUBLIC_ORIGIN: 'https://app.example.test', SERVICE_ORIGIN: 'https://api.example.test',
      TRUST_PROXY: 'true', PASSKEY_RP_ID: 'example.test', DATABASE_URL: 'postgresql://app@example.test/db',
      AUTH_DATABASE_URL: 'postgresql://auth@example.test/db', DATABASE_SSL_CA_FILE: fileURLToPath(import.meta.url), REDIS_URL: 'rediss://example.test',
      BETTER_AUTH_SECRET: '01234567890123456789012345678901', MAGIC_LINK_FROM: 'login@example.test',
      PRIVATE_OBJECT_BUCKET: 'private-example', PUBLIC_DATA_BUCKET: 'catalog-example', CATALOG_MANIFEST_KEY: 'public/manifests/current.json',
      CATALOG_SIGNING_PUBLIC_KEY_PEM: 'public-key', PRIVATE_BUCKET_KMS_KEY_ID: 'alias/app', BATCH_JOB_QUEUE: 'queue',
      BATCH_IMPORT_JOB_DEFINITION: 'import', BATCH_STOCKFISH_JOB_DEFINITION: 'stockfish', BATCH_SCID_JOB_DEFINITION: 'scid',
      BATCH_REFRESH_JOB_DEFINITION: 'refresh', LICHESS_CLIENT_ID: 'client-id', TOKEN_KMS_KEY_ID: 'alias/token',
      EXTERNAL_USER_AGENT: 'LineRecall security@example.test',
    })
    assert.match(config.databaseSsl?.ca ?? '', /configuration and identifiers/u)
    assert.equal(config.databaseSsl?.rejectUnauthorized, true)
  })
})
