import { pgTable, uuid, varchar, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from './tenants';
import { users } from './users';
import { shiftSessions } from './shift-sessions';
import { productBatches } from './product-batches';
import { transactions } from './transactions';
import { purchaseInvoices } from './purchase-invoices';

export const outlets = pgTable('outlets', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  address: text('address'),
  phone: varchar('phone', { length: 20 }),
  siaNumber: varchar('sia_number', { length: 100 }),
  sipaNumber: varchar('sipa_number', { length: 100 }),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const outletsRelations = relations(outlets, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [outlets.tenantId],
    references: [tenants.id],
  }),
  users: many(users),
  shiftSessions: many(shiftSessions),
  batches: many(productBatches),
  transactions: many(transactions),
  purchaseInvoices: many(purchaseInvoices),
}));
