import { pgTable, uuid, varchar, numeric, date, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from './tenants';
import { purchaseInvoices } from './purchase-invoices';
import { users } from './users';

export const purchasePayments = pgTable('purchase_payments', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  purchaseInvoiceId: uuid('purchase_invoice_id').notNull().references(() => purchaseInvoices.id, { onDelete: 'cascade' }),
  paymentDate: date('payment_date').notNull(),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  paymentMethod: varchar('payment_method', { length: 30 }).default('BANK_TRANSFER').notNull(), // 'BANK_TRANSFER', 'CASH', 'GIRO'
  referenceNumber: varchar('reference_number', { length: 100 }), // No rekening / no bukti transfer / no giro
  notes: text('notes'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const purchasePaymentsRelations = relations(purchasePayments, ({ one }) => ({
  tenant: one(tenants, {
    fields: [purchasePayments.tenantId],
    references: [tenants.id],
  }),
  invoice: one(purchaseInvoices, {
    fields: [purchasePayments.purchaseInvoiceId],
    references: [purchaseInvoices.id],
  }),
  user: one(users, {
    fields: [purchasePayments.createdBy],
    references: [users.id],
  }),
}));
