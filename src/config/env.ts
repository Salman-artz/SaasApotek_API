import { z } from 'zod';
import * as dotenv from 'dotenv';

// Load env vars
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3001'),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET minimal 32 karakter untuk memastikan entropi kriptografi yang kuat')
    .refine(
      (val) => {
        if (process.env.NODE_ENV === 'production') {
          return val !== 'super_secret_jwt_key_local_dev_12345' && !val.includes('local_dev');
        }
        return true;
      },
      {
        message: 'Dilarang menggunakan JWT_SECRET bawaan development di environment production!',
      }
    ),
  GEMINI_API_KEY: z.string().optional(),
});

const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
  console.error('❌ Invalid environment variables:', parseResult.error.format());
  process.exit(1);
}

export const env = parseResult.data;
