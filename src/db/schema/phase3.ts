import { pgTable, uuid, varchar, text, numeric, date, timestamp, boolean, integer, jsonb } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { outlets } from './outlets';
import { products } from './products';
import { suppliers } from './suppliers';
import { users } from './users';
import { customers } from './customers';

// 1. SMART DEFECTA (BUKU DEFECTA PINTAR & OTOMASI REORDER)
export const defectaItems = pgTable('defecta_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  outletId: uuid('outlet_id').references(() => outlets.id, { onDelete: 'cascade' }),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),
  currentStock: numeric('current_stock', { precision: 12, scale: 2 }).notNull().default('0'),
  minStock: numeric('min_stock', { precision: 12, scale: 2 }).notNull().default('0'),
  suggestedQty: numeric('suggested_qty', { precision: 12, scale: 2 }).notNull().default('1'),
  priority: varchar('priority', { length: 20 }).notNull().default('HIGH'), // 'CRITICAL' | 'HIGH' | 'MEDIUM'
  status: varchar('status', { length: 30 }).notNull().default('PENDING'), // 'PENDING' | 'ORDERED' | 'RESOLVED'
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 2. MUTASI STOK ANTAR CABANG (INTER-BRANCH TRANSFER)
export const stockTransfers = pgTable('stock_transfers', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  transferCode: varchar('transfer_code', { length: 50 }).notNull(),
  sourceOutletId: uuid('source_outlet_id')
    .notNull()
    .references(() => outlets.id, { onDelete: 'restrict' }),
  destinationOutletId: uuid('destination_outlet_id')
    .notNull()
    .references(() => outlets.id, { onDelete: 'restrict' }),
  status: varchar('status', { length: 30 }).notNull().default('PENDING'), // 'PENDING' | 'IN_TRANSIT' | 'COMPLETED' | 'CANCELLED'
  notes: text('notes'),
  createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const stockTransferItems = pgTable('stock_transfer_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  transferId: uuid('transfer_id')
    .notNull()
    .references(() => stockTransfers.id, { onDelete: 'cascade' }),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
  unitName: varchar('unit_name', { length: 50 }).notNull(),
  notes: text('notes'),
});

// 3. SAAS SUBSCRIPTION & BILLING
export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  plan: varchar('plan', { length: 50 }).notNull().default('PRO'), // 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE'
  status: varchar('status', { length: 30 }).notNull().default('ACTIVE'), // 'TRIAL' | 'ACTIVE' | 'EXPIRED'
  startDate: date('start_date').notNull().defaultNow(),
  endDate: date('end_date').notNull(),
  pricePerMonth: numeric('price_per_month', { precision: 15, scale: 2 }).notNull().default('299000'),
  maxOutlets: integer('max_outlets').notNull().default(3),
  maxProducts: integer('max_products').notNull().default(5000),
  maxMonthlyTrx: integer('max_monthly_trx').notNull().default(10000),
  paymentStatus: varchar('payment_status', { length: 30 }).notNull().default('PAID'),
  invoiceNumber: varchar('invoice_number', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 4. SATUSEHAT KEMENKES INTEGRATION
export const satuSehatConfigs = pgTable('satusehat_configs', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  organizationId: varchar('organization_id', { length: 100 }),
  clientId: varchar('client_id', { length: 255 }),
  clientSecret: text('client_secret'),
  environment: varchar('environment', { length: 30 }).notNull().default('SANDBOX'), // 'SANDBOX' | 'PRODUCTION'
  isConnected: boolean('is_connected').default(false).notNull(),
  lastSyncAt: timestamp('last_sync_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const satuSehatLogs = pgTable('satusehat_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  resourceType: varchar('resource_type', { length: 50 }).notNull(), // 'Medication' | 'MedicationDispense'
  resourceId: varchar('resource_id', { length: 100 }),
  fhirPayload: jsonb('fhir_payload'),
  status: varchar('status', { length: 30 }).notNull().default('SUCCESS'), // 'SUCCESS' | 'FAILED' | 'PENDING'
  responseMessage: text('response_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 5. WA CHRONIC PATIENT REMINDER (PENGINGAT OBAT KRONIS H-3)
export const chronicReminders = pgTable('chronic_reminders', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  customerName: varchar('customer_name', { length: 255 }).notNull(),
  customerPhone: varchar('customer_phone', { length: 50 }).notNull(),
  drugName: varchar('drug_name', { length: 255 }).notNull(),
  signa: varchar('signa', { length: 255 }),
  lastDispenseDate: date('last_dispense_date').notNull(),
  estimatedFinishDate: date('estimated_finish_date').notNull(),
  reminderDate: date('reminder_date').notNull(),
  status: varchar('status', { length: 30 }).notNull().default('PENDING'), // 'PENDING' | 'SENT' | 'DISMISSED'
  sentAt: timestamp('sent_at'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
