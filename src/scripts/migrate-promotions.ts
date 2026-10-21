import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Creating promotions table if not exists...');
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS promotions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      discount_type VARCHAR(20) NOT NULL DEFAULT 'PERCENT',
      discount_value NUMERIC(12, 2) NOT NULL,
      min_purchase NUMERIC(15, 2) DEFAULT 0,
      max_discount NUMERIC(15, 2),
      start_date DATE NOT NULL DEFAULT CURRENT_DATE,
      end_date DATE NOT NULL,
      customer_type VARCHAR(50) NOT NULL DEFAULT 'ALL',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      usage_count INTEGER NOT NULL DEFAULT 0,
      max_usage INTEGER,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  console.log('Table promotions created successfully!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
