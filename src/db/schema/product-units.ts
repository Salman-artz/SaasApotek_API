import { pgTable, uuid, varchar, integer, numeric, boolean } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { products } from './products';

export const productUnits = pgTable('product_units', {
  id: uuid('id').defaultRandom().primaryKey(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  unitName: varchar('unit_name', { length: 30 }).notNull(),
  conversionFactor: integer('conversion_factor').notNull(),
  buyPrice: numeric('buy_price', { precision: 12, scale: 2 }).notNull().default('0'),
  sellPrice: numeric('sell_price', { precision: 12, scale: 2 }).notNull().default('0'),
  isBaseUnit: boolean('is_base_unit').default(false).notNull(),
});

export const productUnitsRelations = relations(productUnits, ({ one }) => ({
  product: one(products, {
    fields: [productUnits.productId],
    references: [products.id],
  }),
}));
