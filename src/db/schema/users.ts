import { pgTable, uuid, varchar, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from './tenants';
import { outlets } from './outlets';
import { transactions } from './transactions';
import { shiftSessions } from './shift-sessions';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  outletId: uuid('outlet_id').references(() => outlets.id, { onDelete: 'set null' }),
  fullName: varchar('full_name', { length: 100 }).notNull(),
  email: varchar('email', { length: 100 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: varchar('role', { length: 20 }).notNull(), // 'super_admin' | 'owner' | 'pharmacist' | 'cashier' | 'inventory'
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [users.tenantId],
    references: [tenants.id],
  }),
  outlet: one(outlets, {
    fields: [users.outletId],
    references: [outlets.id],
  }),
  transactions: many(transactions),
  shiftSessions: many(shiftSessions),
}));
