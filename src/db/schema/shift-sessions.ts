import { pgTable, uuid, varchar, numeric, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from './tenants';
import { outlets } from './outlets';
import { users } from './users';
import { transactions } from './transactions';

export const shiftSessions = pgTable('shift_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  outletId: uuid('outlet_id').notNull().references(() => outlets.id, { onDelete: 'cascade' }),
  cashierId: uuid('cashier_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  openedAt: timestamp('opened_at').defaultNow().notNull(),
  closedAt: timestamp('closed_at'),
  openingCash: numeric('opening_cash', { precision: 12, scale: 2 }).notNull().default('0'),
  closingCash: numeric('closing_cash', { precision: 12, scale: 2 }),
  expectedCash: numeric('expected_cash', { precision: 12, scale: 2 }),
  cashDifference: numeric('cash_difference', { precision: 12, scale: 2 }),
  status: varchar('status', { length: 20 }).default('open').notNull(), // 'open' | 'closed'
  notes: text('notes'),
});

export const shiftSessionsRelations = relations(shiftSessions, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [shiftSessions.tenantId],
    references: [tenants.id],
  }),
  outlet: one(outlets, {
    fields: [shiftSessions.outletId],
    references: [outlets.id],
  }),
  cashier: one(users, {
    fields: [shiftSessions.cashierId],
    references: [users.id],
  }),
  transactions: many(transactions),
}));
