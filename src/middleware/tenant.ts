import { createMiddleware } from 'hono/factory';

export const tenantMiddleware = createMiddleware(async (c, next) => {
  const user = c.get('user');

  if (!user || !user.tenantId) {
    return c.json({ error: 'Forbidden', message: 'Tenant context is missing' }, 403);
  }

  c.set('tenantId', user.tenantId);
  await next();
});
