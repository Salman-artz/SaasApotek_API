import { pgTable, uuid, varchar, integer, numeric, date, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from './tenants';
import { outlets } from './outlets';
import { products } from './products';

export const productBatches = pgTable('product_batches', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  outletId: uuid('outlet_id').notNull().references(() => outlets.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  batchNumber: varchar('batch_number', { length: 50 }).notNull(),
  expiredDate: date('expired_date').notNull(),
  stockInBaseUnit: integer('stock_in_base_unit').default(0).notNull(),
  costPerBaseUnit: numeric('cost_per_base_unit', { precision: 12, scale: 2 }).notNull().default('0'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const productBatchesRelations = relations(productBatches, ({ one }) => ({
  tenant: one(tenants, {
    fields: [productBatches.tenantId],
    references: [tenants.id],
  }),
  outlet: one(outlets, {
    fields: [productBatches.outletId],
    references: [outlets.id],
  }),
  product: one(products, {
    fields: [productBatches.productId],
    references: [products.id],
  }),
}));
