import { sql } from 'drizzle-orm'
import { boolean, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

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

export const board = pgTable('board', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  data: jsonb('data')
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const asset = pgTable('asset', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
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
// account) — a user may connect multiple Notion workspaces or multiple Google
// accounts and we treat each as a separate connection. Tokens are encrypted at
// rest with AES-GCM using CONNECTION_TOKEN_KEY (server-side); the frontend
// only ever sees `id`, `provider`, and `accountEmail`.
export const connection = pgTable('connection', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), // 'notion' | 'drive'
  accountEmail: text('account_email').notNull(),
  // base64(iv ‖ ciphertext ‖ authTag) — see apps/api/src/lib/cryptoTokens.ts
  accessTokenEnc: text('access_token_enc').notNull(),
  refreshTokenEnc: text('refresh_token_enc'),
  expiresAt: timestamp('expires_at'),
  scopes: text('scopes').notNull(),
  // Notion-specific (nullable for Drive). Kept as flat columns rather than
  // a JSON blob so we can index/filter cheaply if we ever need to.
  workspaceId: text('workspace_id'),
  workspaceName: text('workspace_name'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
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
  mimeType: text('mime_type'), // null for Notion
  lastUsedAt: timestamp('last_used_at').notNull().defaultNow(),
})
