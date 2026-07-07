import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Drizzle defs mirror migrations/0001_init.sql. DB-side defaults (unixepoch())
// are applied by the DDL, so inserts pass timestamps explicitly.

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: integer('created_at'),
})

export const members = sqliteTable('members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tenantId: text('tenant_id').notNull(),
  email: text('email').notNull(),
  role: text('role', { enum: ['owner', 'admin', 'viewer'] }).notNull(),
  createdAt: integer('created_at'),
})

export const explorers = sqliteTable('explorers', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  key: text('key').notNull(),
  brand: text('brand').notNull(),
  publicUrl: text('public_url').notNull(),
  originUrl: text('origin_url').notNull(),
  renderWebId: text('render_web_id'),
  renderIndexerId: text('render_indexer_id'),
  renderDbId: text('render_db_id'),
  cfZoneId: text('cf_zone_id'),
  ga4PropertyId: text('ga4_property_id'),
  adminSecretBinding: text('admin_secret_binding').notNull(),
  status: text('status', { enum: ['live', 'provisioning', 'suspended'] }).notNull(),
  createdAt: integer('created_at'),
})

export const audit = sqliteTable('audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actorEmail: text('actor_email').notNull(),
  tenantId: text('tenant_id'),
  explorerId: text('explorer_id'),
  action: text('action').notNull(),
  payload: text('payload'),
  at: integer('at').notNull(),
})

export type ExplorerRow = typeof explorers.$inferSelect
