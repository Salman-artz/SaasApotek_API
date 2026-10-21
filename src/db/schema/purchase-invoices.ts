import { pgTable, uuid, varchar, numeric, date, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from './tenants';
import { outlets } from './outlets';
import { suppliers } from './suppliers';
import { purchaseItems } from './purchase-items';

export const purchaseInvoices = pgTable('purchase_invoices', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  outletId: uuid('outlet_id').notNull().references(() => outlets.id, { onDelete: 'cascade' }),
  supplierId: uuid('supplier_id').notNull().references(() => suppliers.id, { onDelete: 'restrict' }),
  invoiceNumber: varchar('invoice_number', { length: 100 }).notNull(),
  invoiceDate: date('invoice_date').notNull(),
  dueDate: date('due_date'),
  totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  paymentStatus: varchar('payment_status', { length: 20 }).default('unpaid').notNull(), // 'unpaid' | 'partial' | 'paid'
  paidAmount: numeric('paid_amount', { precision: 14, scale: 2 }).default('0').notNull(),
  scanInvoiceUrl: text('scan_invoice_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const purchaseInvoicesRelations = relations(purchaseInvoices, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [purchaseInvoices.tenantId],
    references: [tenants.id],
  }),
  outlet: one(outlets, {
    fields: [purchaseInvoices.outletId],
    references: [outlets.id],
  }),
  supplier: one(suppliers, {
    fields: [purchaseInvoices.supplierId],
    references: [suppliers.id],
  }),
  items: many(purchaseItems),
}));
