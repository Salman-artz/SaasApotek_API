import { createMiddleware } from 'hono/factory';

export const requireRole = (allowedRoles: string[]) => {
  return createMiddleware(async (c, next) => {
    const user = c.get('user');

    if (!user || !user.role || !allowedRoles.includes(user.role)) {
      return c.json(
        {
          success: false,
          error: 'Forbidden',
          message: 'Akses Ditolak: Anda tidak memiliki izin untuk mengakses resource ini.',
        },
        403
      );
    }

    await next();
  });
};
