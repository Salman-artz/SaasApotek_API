import { pgTable, uuid, varchar, text, numeric, date, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { outlets } from './outlets';
import { users } from './users';

export const expenses = pgTable('expenses', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  outletId: uuid('outlet_id').references(() => outlets.id, { onDelete: 'set null' }),
  category: varchar('category', { length: 100 }).notNull(),
  expenseDate: date('expense_date').notNull().defaultNow(),
  amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
  paymentMethod: varchar('payment_method', { length: 50 }).notNull().default('CASH'),
  recipient: varchar('recipient', { length: 255 }),
  notes: text('notes'),
  receiptUrl: text('receipt_url'),
  createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
