import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AuthUser } from '../types/index.js';

export const authMiddleware = createMiddleware(async (c, next) => {
  const cookieToken = getCookie(c, 'auth_token');
  const authHeader = c.req.header('Authorization');
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  const token = cookieToken || bearerToken;

  if (!token) {
    return c.json({ error: 'Unauthorized', message: 'Missing or invalid token' }, 401);
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as AuthUser;
    
    // Set user in context
    c.set('user', decoded);
    
    await next();
  } catch (error) {
    return c.json({ error: 'Unauthorized', message: 'Invalid or expired token' }, 401);
  }
});
