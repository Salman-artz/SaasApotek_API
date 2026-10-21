import { pgTable, uuid, varchar, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from './tenants';
import { outlets } from './outlets';
import { products } from './products';
import { productBatches } from './product-batches';
import { users } from './users';

export const stockMutations = pgTable('stock_mutations', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  outletId: uuid('outlet_id').notNull().references(() => outlets.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  batchId: uuid('batch_id').references(() => productBatches.id, { onDelete: 'set null' }),
  type: varchar('type', { length: 30 }).notNull(), // 'INITIAL', 'PURCHASE', 'SALE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'OPNAME', 'RETURN'
  referenceType: varchar('reference_type', { length: 50 }), // 'PURCHASE_INVOICE', 'POS_TRANSACTION', 'STOCK_OPNAME', 'MANUAL'
  referenceNumber: varchar('reference_number', { length: 100 }),
  qtyIn: integer('qty_in').default(0).notNull(),
  qtyOut: integer('qty_out').default(0).notNull(),
  balanceAfter: integer('balance_after').notNull(),
  notes: text('notes'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const stockMutationsRelations = relations(stockMutations, ({ one }) => ({
  tenant: one(tenants, {
    fields: [stockMutations.tenantId],
    references: [tenants.id],
  }),
  outlet: one(outlets, {
    fields: [stockMutations.outletId],
    references: [outlets.id],
  }),
  product: one(products, {
    fields: [stockMutations.productId],
    references: [products.id],
  }),
  batch: one(productBatches, {
    fields: [stockMutations.batchId],
    references: [productBatches.id],
  }),
  user: one(users, {
    fields: [stockMutations.createdBy],
    references: [users.id],
  }),
}));
