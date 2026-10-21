import { pgTable, uuid, varchar, numeric, boolean, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from './tenants';
import { outlets } from './outlets';
import { users } from './users';
import { shiftSessions } from './shift-sessions';
import { transactionItems } from './transaction-items';

export const transactions = pgTable('transactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  outletId: uuid('outlet_id').notNull().references(() => outlets.id, { onDelete: 'cascade' }),
  cashierId: uuid('cashier_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  shiftSessionId: uuid('shift_session_id').references(() => shiftSessions.id, { onDelete: 'set null' }),
  invoiceCode: varchar('invoice_code', { length: 50 }).notNull().unique(),
  customerName: varchar('customer_name', { length: 100 }),
  customerPhone: varchar('customer_phone', { length: 20 }),
  doctorName: varchar('doctor_name', { length: 100 }),
  prescriptionNumber: varchar('prescription_number', { length: 100 }),
  isPrescription: boolean('is_prescription').default(false).notNull(),
  tuslahFee: numeric('tuslah_fee', { precision: 12, scale: 2 }).default('0').notNull(),
  totalSubtotal: numeric('total_subtotal', { precision: 14, scale: 2 }).notNull().default('0'),
  discountAmount: numeric('discount_amount', { precision: 12, scale: 2 }).default('0').notNull(),
  taxAmount: numeric('tax_amount', { precision: 12, scale: 2 }).default('0').notNull(),
  grandTotal: numeric('grand_total', { precision: 14, scale: 2 }).notNull().default('0'),
  paidAmount: numeric('paid_amount', { precision: 14, scale: 2 }).default('0').notNull(),
  changeAmount: numeric('change_amount', { precision: 14, scale: 2 }).default('0').notNull(),
  paymentMethod: varchar('payment_method', { length: 30 }).notNull(), // 'cash' | 'qris' | 'transfer' | 'debit'
  paymentStatus: varchar('payment_status', { length: 20 }).default('completed').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const transactionsRelations = relations(transactions, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [transactions.tenantId],
    references: [tenants.id],
  }),
  outlet: one(outlets, {
    fields: [transactions.outletId],
    references: [outlets.id],
  }),
  cashier: one(users, {
    fields: [transactions.cashierId],
    references: [users.id],
  }),
  shiftSession: one(shiftSessions, {
    fields: [transactions.shiftSessionId],
    references: [shiftSessions.id],
  }),
  items: many(transactionItems),
}));
