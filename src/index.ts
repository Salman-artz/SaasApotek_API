import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import { env } from './config/env';
import routes from './routes/index';

const app = new Hono();

// Security Headers (Anti-Clickjacking, X-Content-Type-Options, HSTS)
app.use('*', secureHeaders());

// Middleware
app.use('*', logger());

// Strict CORS with explicit origin matching & credentials support
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

app.use('*', cors({
  origin: (origin) => {
    if (!origin) return allowedOrigins[0] || 'http://localhost:3000';
    if (allowedOrigins.includes(origin)) return origin;
    if (env.NODE_ENV !== 'production' && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
      return origin;
    }
    return null;
  },
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

// Health check route
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'Apotek Digital API', timestamp: new Date().toISOString() });
});

// API Routes
app.route('/api', routes);
app.route('/', routes);

// 404 Handler
app.notFound((c) => {
  return c.json({ error: 'Not Found', message: 'Endpoint tidak ditemukan' }, 404);
});

// Error Handler
app.onError((err, c) => {
  console.error('Unhandled server error:', err);
  const isProd = env.NODE_ENV === 'production';
  return c.json({
    success: false,
    error: 'Internal Server Error',
    message: isProd
      ? 'Terjadi kesalahan pada sistem. Silakan hubungi dukungan teknis.'
      : (err.message || 'Server error'),
  }, 500);
});

const port = env.PORT || 3001;

if (!process.env.VERCEL) {
  console.log(`🚀 Apotek Digital API Server is running on http://localhost:${port}`);
  serve({
    fetch: app.fetch,
    port,
  });
}

export default app;
