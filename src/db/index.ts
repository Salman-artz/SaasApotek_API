import { PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

// Setup connection
const queryClient = postgres(env.DATABASE_URL);
export const db: PostgresJsDatabase<typeof schema> = drizzle(queryClient, { schema });
