import { pgTable, uuid, varchar, boolean, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { outlets } from './outlets';
import { users } from './users';
import { products } from './products';
import { customers } from './customers';
import { suppliers } from './suppliers';

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 150 }).notNull(),
  slug: varchar('slug', { length: 50 }).notNull().unique(),
  plan: varchar('plan', { length: 20 }).default('starter').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const tenantsRelations = relations(tenants, ({ many }) => ({
  outlets: many(outlets),
  users: many(users),
  products: many(products),
  customers: many(customers),
  suppliers: many(suppliers),
}));
