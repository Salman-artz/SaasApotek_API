import { pgTable, uuid, integer, numeric } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { purchaseInvoices } from './purchase-invoices';
import { products } from './products';
import { productBatches } from './product-batches';
import { productUnits } from './product-units';

export const purchaseItems = pgTable('purchase_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  purchaseInvoiceId: uuid('purchase_invoice_id').notNull().references(() => purchaseInvoices.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'restrict' }),
  batchId: uuid('batch_id').notNull().references(() => productBatches.id, { onDelete: 'restrict' }),
  unitId: uuid('unit_id').notNull().references(() => productUnits.id, { onDelete: 'restrict' }),
  quantity: integer('quantity').notNull(),
  pricePerUnit: numeric('price_per_unit', { precision: 12, scale: 2 }).notNull(),
  discount: numeric('discount', { precision: 12, scale: 2 }).default('0').notNull(),
  subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull(),
});

export const purchaseItemsRelations = relations(purchaseItems, ({ one }) => ({
  purchaseInvoice: one(purchaseInvoices, {
    fields: [purchaseItems.purchaseInvoiceId],
    references: [purchaseInvoices.id],
  }),
  product: one(products, {
    fields: [purchaseItems.productId],
    references: [products.id],
  }),
  batch: one(productBatches, {
    fields: [purchaseItems.batchId],
    references: [productBatches.id],
  }),
  unit: one(productUnits, {
    fields: [purchaseItems.unitId],
    references: [productUnits.id],
  }),
}));
