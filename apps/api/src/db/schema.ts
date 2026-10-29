import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// better-auth tables (singular names, matches better-auth v1 defaults).
// Schema mirrors the better-auth Drizzle adapter so Phase 4b can plug in
// without another migration.
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
// App tables
// ---------------------------------------------------------------------------

// Single internal team: every signed-in user sees and edits every board,
// asset and share. `createdBy` is attribution only; it survives the
// creator's account being deleted as null.
export const board = pgTable('board', {
  id: text('id').primaryKey(),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// One row per canvas object. `object` is the full CanvasObject (geometry +
// per-type data); `type` is lifted out so queries can filter without
// unpacking JSON. `version` increments on every write — clients send the
// version they last saw and a mismatch is reported as a conflict rather
// than overwritten. Object ids are client-minted, so the key is scoped to
// the board.
export const boardObject = pgTable(
  'board_object',
  {
    boardId: text('board_id')
      .notNull()
      .references(() => board.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    type: text('type').notNull(),
    object: jsonb('object').notNull(),
    version: integer('version').notNull().default(1),
    updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.boardId, t.id] }),
    typeIdx: index('board_object_type_idx').on(t.type),
  }),
)

export const asset = pgTable('asset', {
  id: text('id').primaryKey(),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  // 'upload' (images on UPLOADS_DIR), 'pdf' (PDFs on PDF_DIR),
  // 'pdf-thumb' (server-rendered first-page PNG on PDF_THUMB_DIR).
  // Drives which directory /api/files/:filename serves from.
  kind: text('kind').notNull().default('upload'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// Cache for AI group analyses. Key = sha256 of (sorted object IDs +
// per-object content hash + model tag). Same content → same key → reuse.
export const groupAnalysis = pgTable('group_analysis', {
  cacheKey: text('cache_key').primaryKey(),
  model: text('model').notNull(),
  analysis: jsonb('analysis').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// External-source OAuth connections (Phase 12+). One row per (user, provider,
// account) — a user may connect multiple Google accounts and we treat each as a separate connection. Tokens are encrypted at
// rest with AES-GCM using CONNECTION_TOKEN_KEY (server-side); the frontend
// only ever sees `id`, `provider`, and `accountEmail`.
export const connection = pgTable('connection', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), // 'drive' | 'spotify'
  accountEmail: text('account_email').notNull(),
  // base64(iv ‖ ciphertext ‖ authTag) — see apps/api/src/lib/cryptoTokens.ts
  accessTokenEnc: text('access_token_enc').notNull(),
  refreshTokenEnc: text('refresh_token_enc'),
  expiresAt: timestamp('expires_at'),
  scopes: text('scopes').notNull(),
  // Org/workspace the account belongs to, for providers that have one.
  // Flat columns so we can index/filter cheaply.
  workspaceId: text('workspace_id'),
  workspaceName: text('workspace_name'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
})

// Phase 18 — Shareable moodboards. Frozen, immutable snapshot of a board
// + the per-group synthesis brief, exposed via an unguessable token.
// One share per board: create/update is upsert; "Update
// snapshot" replaces snapshot+assetFilenames+capturedAt and nulls out
// the cached PDF. Token survives updates so existing recipients keep
// the same URL. assetFilenames gates the public file-streaming endpoint
// so a token can only reach files that were on the canvas at snapshot
// time.
export const share = pgTable(
  'share',
  {
    token: text('token').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => board.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    // text[] of upload filenames the snapshot references. The public
    // share-file endpoint requires the requested filename to be in this
    // allowlist, so a token can't be used to fish unrelated assets.
    assetFilenames: text('asset_filenames')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    pdfFilename: text('pdf_filename'),
    pdfGeneratedAt: timestamp('pdf_generated_at'),
    capturedAt: timestamp('captured_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    // One share per board. The share endpoint upserts on this.
    boardIdx: uniqueIndex('share_board_idx').on(t.boardId),
  }),
)

// Per-group analysis-panel state for a board, shared by the team: the
// displayed analysis (`kind` + `data`, null until a run completes), the
// agents that produced it, the agent-row selection, and the palette the
// widget locks to. Analyze/synthesize routes write the display on
// completion; the client writes selection and inline edits. MCP get_board
// reads it.
//
// `groupKey` is the sorted-join of object IDs (groupId() in
// packages/shared/src/aabb.ts). Membership changes mint a new key; rows
// whose key references a deleted object can never match again and are
// pruned by the orphan cleanup.
export const boardGroupDisplay = pgTable(
  'board_group_display',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => board.id, { onDelete: 'cascade' }),
    groupKey: text('group_key').notNull(),
    // Mirror of SharedAnalysisDisplay.kind: 'ad' | 'sectioned' | 'video' | 'brief'.
    kind: text('kind'),
    data: jsonb('data'),
    agentIds: text('agent_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    selectedAgentIds: text('selected_agent_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    aiPalette: text('ai_palette')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    boardGroupIdx: uniqueIndex('board_group_display_board_group_idx').on(t.boardId, t.groupKey),
  }),
)

// Phase 19 — MCP server API keys. One row per minted key; the plaintext
// is shown to the user exactly once at creation and never persisted.
// `hashedKey` is sha256(plaintext); `prefix` is the first 7 chars of
// the plaintext for display in the dashboard (e.g. "mb_ABC1…").
// `lastUsedAt` is bumped async on each MCP request so the dashboard
// can surface idle keys. Cascade-delete with the user.
export const apiKey = pgTable('api_key', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  hashedKey: text('hashed_key').notNull().unique(),
  lastUsedAt: timestamp('last_used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// Per-user recent picks across sources. Drives the picker drawer's "Recents"
// tab without re-querying the provider every time. Capped server-side; old
// entries beyond the cap are pruned on insert.
export const recentExternal = pgTable('recent_external', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id')
    .notNull()
    .references(() => connection.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(), // pageId / fileId / folderId
  kind: text('kind').notNull(), // 'page' | 'file' | 'folder'
  title: text('title').notNull(),
  iconUrl: text('icon_url'),
  mimeType: text('mime_type'), // Spotify stores its sub-kind here
  lastUsedAt: timestamp('last_used_at').notNull().defaultNow(),
})
