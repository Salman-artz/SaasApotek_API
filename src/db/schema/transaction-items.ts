import { pgTable, uuid, integer, numeric, boolean, varchar } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { transactions } from './transactions';
import { products } from './products';
import { productBatches } from './product-batches';
import { productUnits } from './product-units';

export const transactionItems = pgTable('transaction_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  transactionId: uuid('transaction_id').notNull().references(() => transactions.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'restrict' }),
  batchId: uuid('batch_id').notNull().references(() => productBatches.id, { onDelete: 'restrict' }),
  unitId: uuid('unit_id').notNull().references(() => productUnits.id, { onDelete: 'restrict' }),
  quantity: integer('quantity').notNull(),
  baseQuantityDeducted: integer('base_quantity_deducted').notNull(),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  discountPerItem: numeric('discount_per_item', { precision: 12, scale: 2 }).default('0').notNull(),
  subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull(),
  isRacikan: boolean('is_racikan').default(false).notNull(),
  racikanName: varchar('racikan_name', { length: 100 }),
  signa: varchar('signa', { length: 150 }), // e.g. "3 x 1 Tablet Sehari Sesudah Makan"
});

export const transactionItemsRelations = relations(transactionItems, ({ one }) => ({
  transaction: one(transactions, {
    fields: [transactionItems.transactionId],
    references: [transactions.id],
  }),
  product: one(products, {
    fields: [transactionItems.productId],
    references: [products.id],
  }),
  batch: one(productBatches, {
    fields: [transactionItems.batchId],
    references: [productBatches.id],
  }),
  unit: one(productUnits, {
    fields: [transactionItems.unitId],
    references: [productUnits.id],
  }),
}));
