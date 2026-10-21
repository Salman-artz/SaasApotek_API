import { pgTable, uuid, varchar, boolean, integer, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from './tenants';
import { productUnits } from './product-units';
import { productBatches } from './product-batches';

export const products = pgTable('products', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  genericName: varchar('generic_name', { length: 200 }),
  sku: varchar('sku', { length: 50 }),
  barcode: varchar('barcode', { length: 50 }),
  category: varchar('category', { length: 50 }), // 'Bebas' | 'Bebas Terbatas' | 'Keras' | 'Narkotika' | 'Psikotropika' | 'Alkes'
  requiresPrescription: boolean('requires_prescription').default(false).notNull(),
  minStockAlert: integer('min_stock_alert').default(10).notNull(),
  baseUnit: varchar('base_unit', { length: 20 }).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const productsRelations = relations(products, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [products.tenantId],
    references: [tenants.id],
  }),
  units: many(productUnits),
  batches: many(productBatches),
}));
