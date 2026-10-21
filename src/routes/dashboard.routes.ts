import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { tenantMiddleware } from '../middleware/tenant.js';

const router = new Hono();

router.use('*', authMiddleware, tenantMiddleware);

router.get('/stats', async (c) => {
  return c.json({
    totalSales: 0,
    totalProducts: 0,
    totalTransactions: 0,
    recentActivity: []
  });
});

export default router;
