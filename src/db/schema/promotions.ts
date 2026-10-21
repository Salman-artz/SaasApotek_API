import { pgTable, uuid, varchar, numeric, date, boolean, integer, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const promotions = pgTable('promotions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  code: varchar('code', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  discountType: varchar('discount_type', { length: 20 }).notNull().default('PERCENT'), // 'PERCENT' | 'FIXED'
  discountValue: numeric('discount_value', { precision: 12, scale: 2 }).notNull(),
  minPurchase: numeric('min_purchase', { precision: 15, scale: 2 }).default('0'),
  maxDiscount: numeric('max_discount', { precision: 15, scale: 2 }),
  startDate: date('start_date').notNull().defaultNow(),
  endDate: date('end_date').notNull(),
  customerType: varchar('customer_type', { length: 50 }).notNull().default('ALL'), // 'ALL' | 'MEMBER' | 'RESEP'
  isActive: boolean('is_active').default(true).notNull(),
  usageCount: integer('usage_count').default(0).notNull(),
  maxUsage: integer('max_usage'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Promotion = typeof promotions.$inferSelect;
export type NewPromotion = typeof promotions.$inferInsert;
