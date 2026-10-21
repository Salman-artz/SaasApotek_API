import { pgTable, uuid, varchar, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from './tenants';
import { outlets } from './outlets';
import { products } from './products';
import { productBatches } from './product-batches';
import { users } from './users';

export const stockOpnames = pgTable('stock_opnames', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  outletId: uuid('outlet_id').notNull().references(() => outlets.id, { onDelete: 'cascade' }),
  opnameNumber: varchar('opname_number', { length: 50 }).notNull(),
  status: varchar('status', { length: 20 }).default('COMPLETED').notNull(), // 'DRAFT', 'COMPLETED', 'CANCELLED'
  totalItems: integer('total_items').default(0).notNull(),
  totalVariance: integer('total_variance').default(0).notNull(),
  notes: text('notes'),
  conductedBy: uuid('conducted_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const stockOpnameItems = pgTable('stock_opname_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  opnameId: uuid('opname_id').notNull().references(() => stockOpnames.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  batchId: uuid('batch_id').references(() => productBatches.id, { onDelete: 'set null' }),
  systemStock: integer('system_stock').notNull(),
  physicalStock: integer('physical_stock').notNull(),
  variance: integer('variance').notNull(), // physicalStock - systemStock
  reason: varchar('reason', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const stockOpnamesRelations = relations(stockOpnames, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [stockOpnames.tenantId],
    references: [tenants.id],
  }),
  outlet: one(outlets, {
    fields: [stockOpnames.outletId],
    references: [outlets.id],
  }),
  user: one(users, {
    fields: [stockOpnames.conductedBy],
    references: [users.id],
  }),
  items: many(stockOpnameItems),
}));

export const stockOpnameItemsRelations = relations(stockOpnameItems, ({ one }) => ({
  opname: one(stockOpnames, {
    fields: [stockOpnameItems.opnameId],
    references: [stockOpnames.id],
  }),
  product: one(products, {
    fields: [stockOpnameItems.productId],
    references: [products.id],
  }),
  batch: one(productBatches, {
    fields: [stockOpnameItems.batchId],
    references: [productBatches.id],
  }),
}));
