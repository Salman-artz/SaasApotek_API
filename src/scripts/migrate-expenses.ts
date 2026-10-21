import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Creating expenses table if not exists...');
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS expenses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      outlet_id UUID REFERENCES outlets(id) ON DELETE SET NULL,
      category VARCHAR(100) NOT NULL,
      expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
      amount NUMERIC(15, 2) NOT NULL,
      payment_method VARCHAR(50) NOT NULL DEFAULT 'CASH',
      recipient VARCHAR(255),
      notes TEXT,
      receipt_url TEXT,
      created_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  console.log('Table expenses created successfully!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
