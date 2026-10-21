import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Creating Phase 3 tables if not exists...');
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS defecta_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      outlet_id UUID REFERENCES outlets(id) ON DELETE CASCADE,
      product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
      current_stock NUMERIC(12, 2) NOT NULL DEFAULT 0,
      min_stock NUMERIC(12, 2) NOT NULL DEFAULT 0,
      suggested_qty NUMERIC(12, 2) NOT NULL DEFAULT 1,
      priority VARCHAR(20) NOT NULL DEFAULT 'HIGH',
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock_transfers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      transfer_code VARCHAR(50) NOT NULL,
      source_outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE RESTRICT,
      destination_outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE RESTRICT,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      notes TEXT,
      created_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock_transfer_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      transfer_id UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
      product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity NUMERIC(12, 2) NOT NULL,
      unit_name VARCHAR(50) NOT NULL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      plan VARCHAR(50) NOT NULL DEFAULT 'PRO',
      status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
      start_date DATE NOT NULL DEFAULT CURRENT_DATE,
      end_date DATE NOT NULL,
      price_per_month NUMERIC(15, 2) NOT NULL DEFAULT 299000,
      max_outlets INTEGER NOT NULL DEFAULT 3,
      max_products INTEGER NOT NULL DEFAULT 5000,
      max_monthly_trx INTEGER NOT NULL DEFAULT 10000,
      payment_status VARCHAR(30) NOT NULL DEFAULT 'PAID',
      invoice_number VARCHAR(100),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS satusehat_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      organization_id VARCHAR(100),
      client_id VARCHAR(255),
      client_secret TEXT,
      environment VARCHAR(30) NOT NULL DEFAULT 'SANDBOX',
      is_connected BOOLEAN NOT NULL DEFAULT FALSE,
      last_sync_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS satusehat_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      resource_type VARCHAR(50) NOT NULL,
      resource_id VARCHAR(100),
      fhir_payload JSONB,
      status VARCHAR(30) NOT NULL DEFAULT 'SUCCESS',
      response_message TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chronic_reminders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
      customer_name VARCHAR(255) NOT NULL,
      customer_phone VARCHAR(50) NOT NULL,
      drug_name VARCHAR(255) NOT NULL,
      signa VARCHAR(255),
      last_dispense_date DATE NOT NULL,
      estimated_finish_date DATE NOT NULL,
      reminder_date DATE NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      sent_at TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  console.log('All Phase 3 tables created successfully!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
