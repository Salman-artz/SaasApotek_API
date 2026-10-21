import { PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

// Setup high-performance connection pool
const queryClient = postgres(env.DATABASE_URL, {
  max: 20, // Connection pool size
  idle_timeout: 30, // Tutup koneksi idle setelah 30 detik
  connect_timeout: 10, // Maksimal 10 detik untuk koneksi
  prepare: true, // Gunakan prepared statements untuk kecepatan query
});

export const db: PostgresJsDatabase<typeof schema> = drizzle(queryClient, { schema });
