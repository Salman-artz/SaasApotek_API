import { createMiddleware } from 'hono/factory';
import { env } from '../config/env';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
  keyGenerator?: (c: any) => string;
}

interface RequestRecord {
  count: number;
  resetTime: number;
}

export const createRateLimiter = (options: RateLimitOptions) => {
  const {
    windowMs,
    max,
    message = 'Terlalu banyak permintaan. Silakan coba lagi beberapa saat.',
    keyGenerator = (c) => {
      const forwarded = c.req.header('x-forwarded-for');
      return forwarded ? forwarded.split(',')[0].trim() : (c.req.header('x-real-ip') || 'local-client');
    },
  } = options;

  const hits = new Map<string, RequestRecord>();

  // Cleanup expired entries periodically to prevent memory leaks
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of hits.entries()) {
      if (now > record.resetTime) {
        hits.delete(key);
      }
    }
  }, 60000);
  
  if (timer.unref) {
    timer.unref();
  }

  return createMiddleware(async (c, next) => {
    // In development or test environment, bypass rate limiting for seamless local testing
    if (env.NODE_ENV !== 'production') {
      await next();
      return;
    }

    const key = keyGenerator(c);
    const now = Date.now();

    const record = hits.get(key);

    if (!record || now > record.resetTime) {
      hits.set(key, {
        count: 1,
        resetTime: now + windowMs,
      });
      c.header('X-RateLimit-Limit', max.toString());
      c.header('X-RateLimit-Remaining', (max - 1).toString());
      await next();
      return;
    }

    if (record.count >= max) {
      const retryAfterSeconds = Math.ceil((record.resetTime - now) / 1000);
      c.header('Retry-After', retryAfterSeconds.toString());
      c.header('X-RateLimit-Limit', max.toString());
      c.header('X-RateLimit-Remaining', '0');
      return c.json(
        {
          success: false,
          error: 'Too Many Requests',
          message,
          retryAfterSeconds,
        },
        429
      );
    }

    record.count += 1;
    c.header('X-RateLimit-Limit', max.toString());
    c.header('X-RateLimit-Remaining', Math.max(0, max - record.count).toString());
    await next();
  });
};
