import { pgTable, uuid, varchar, text, timestamp, integer } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from './tenants';
import { outlets } from './outlets';
import { suppliers } from './suppliers';
import { products } from './products';
import { users } from './users';

export const purchaseOrders = pgTable('purchase_orders', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  outletId: uuid('outlet_id').notNull().references(() => outlets.id, { onDelete: 'cascade' }),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'restrict' }),
  orderNumber: varchar('order_number', { length: 100 }).notNull(),
  orderType: varchar('order_type', { length: 30 }).default('REGULAR').notNull(), // 'REGULAR', 'PRECURSOR', 'OOT', 'PSYCHOTROPIC', 'NARCOTIC'
  orderDate: varchar('order_date', { length: 20 }).notNull(),
  status: varchar('status', { length: 30 }).default('SENT').notNull(), // 'DRAFT', 'SENT', 'RECEIVED', 'CANCELLED'
  apaName: varchar('apa_name', { length: 150 }),
  apaSipa: varchar('apa_sipa', { length: 100 }),
  notes: text('notes'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const purchaseOrderItems = pgTable('purchase_order_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  purchaseOrderId: uuid('purchase_order_id').notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'restrict' }),
  quantity: integer('quantity').notNull(),
  unitName: varchar('unit_name', { length: 50 }).notNull(),
  dosageForm: varchar('dosage_form', { length: 100 }), // Tablet / Sirup / Kapsul / Ampul
  strength: varchar('strength', { length: 100 }), // 500 mg / 100 ml
  notes: text('notes'),
});

export const purchaseOrdersRelations = relations(purchaseOrders, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [purchaseOrders.tenantId],
    references: [tenants.id],
  }),
  outlet: one(outlets, {
    fields: [purchaseOrders.outletId],
    references: [outlets.id],
  }),
  supplier: one(suppliers, {
    fields: [purchaseOrders.supplierId],
    references: [suppliers.id],
  }),
  user: one(users, {
    fields: [purchaseOrders.createdBy],
    references: [users.id],
  }),
  items: many(purchaseOrderItems),
}));

export const purchaseOrderItemsRelations = relations(purchaseOrderItems, ({ one }) => ({
  order: one(purchaseOrders, {
    fields: [purchaseOrderItems.purchaseOrderId],
    references: [purchaseOrders.id],
  }),
  product: one(products, {
    fields: [purchaseOrderItems.productId],
    references: [products.id],
  }),
}));
