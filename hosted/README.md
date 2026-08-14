# LineRecall hosted client

This client composes the offline-capable React application with account, review, puzzle, and unified-family cloud adapters. It does not persist credentials or progress in `localStorage` or IndexedDB.

`CloudFamilyTrainingJournalRepository` implements the application's existing family journal interface against the versioned `/v1/family-training/*` API. Completion and cycle events retain immutable IDs across retry. Cursor snapshots retain one UUIDv7 mutation ID until acknowledged and use optimistic versions. Failed network writes remain in memory and are retried by the online handler. The strict `linerecall-unsynced-events-v4` download includes queued reviews, puzzle attempts, family events, and family cursors; the complete server-held journal is included in account export v5.

The adapter uses bounded pages (500 records, at most 200 pages per read) and a 50,000-record in-memory queue ceiling. A server membership or immutable-ID rejection is surfaced rather than silently changed. Tests cover lost-response retry identity and a 1,005-path cursor without truncation.

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

This directory is deployable source, not evidence that accounts are live. Connected staging, real forced-RLS role testing, backup/restore, provider, security, and release gates remain required before enabling production accounts.
