import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { db } from '../db/index';
import {
  stockTransfers,
  stockTransferItems,
  outlets,
  products,
  productBatches,
} from '../db/schema/index';
import { eq, and, desc, sql } from 'drizzle-orm';
import {
  assertOutletBelongsToTenant,
  assertProductsBelongToTenant,
  TenantSecurityError,
} from '../lib/tenant-validator';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

// 1. LIST TRANSFERS
router.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');

    const transfers = await db
      .select({
        id: stockTransfers.id,
        transferCode: stockTransfers.transferCode,
        sourceOutletId: stockTransfers.sourceOutletId,
        destinationOutletId: stockTransfers.destinationOutletId,
        status: stockTransfers.status,
        notes: stockTransfers.notes,
        createdAt: stockTransfers.createdAt,
      })
      .from(stockTransfers)
      .where(eq(stockTransfers.tenantId, tenantId))
      .orderBy(desc(stockTransfers.createdAt));

    // Enhance with outlet names
    const outletsList = await db.select().from(outlets).where(eq(outlets.tenantId, tenantId));
    const outletMap = new Map(outletsList.map((o) => [o.id, o.name]));

    const enriched = transfers.map((t) => ({
      ...t,
      sourceOutletName: outletMap.get(t.sourceOutletId) || 'Cabang Asal',
      destinationOutletName: outletMap.get(t.destinationOutletId) || 'Cabang Tujuan',
    }));

    return c.json({ success: true, data: enriched });
  } catch (error: any) {
    console.error('Error fetching stock transfers:', error);
    return c.json({ success: false, message: 'Gagal memuat mutasi antar cabang', error: error.message }, 500);
  }
});

// 2. CREATE STOCK TRANSFER
const transferSchema = z.object({
  sourceOutletId: z.string().uuid('Pilih cabang asal'),
  destinationOutletId: z.string().uuid('Pilih cabang tujuan'),
  notes: z.string().optional(),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.number().min(1),
      unitName: z.string().default('Pcs'),
      notes: z.string().optional(),
    })
  ).min(1, 'Minimal transfer 1 item obat'),
});

router.post('/', requireRole(['owner', 'super_admin', 'pharmacist', 'inventory']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const body = await c.req.json();
    const validated = transferSchema.parse(body);

    if (validated.sourceOutletId === validated.destinationOutletId) {
      return c.json({ success: false, message: 'Cabang asal dan tujuan tidak boleh sama' }, 400);
    }

    // Cross-Tenant IDOR Protection
    await assertOutletBelongsToTenant(db, validated.sourceOutletId, tenantId);
    await assertOutletBelongsToTenant(db, validated.destinationOutletId, tenantId);
    await assertProductsBelongToTenant(db, validated.items.map((i) => i.productId), tenantId);

    const transferCode = `TRF-${Date.now().toString().slice(-6)}`;

    const [newTransfer] = await db
      .insert(stockTransfers)
      .values({
        tenantId,
        transferCode,
        sourceOutletId: validated.sourceOutletId,
        destinationOutletId: validated.destinationOutletId,
        status: 'IN_TRANSIT',
        notes: validated.notes,
        createdById: user.id,
      })
      .returning();

    for (const item of validated.items) {
      await db.insert(stockTransferItems).values({
        transferId: newTransfer.id,
        productId: item.productId,
        quantity: item.quantity.toString(),
        unitName: item.unitName,
        notes: item.notes,
      });
    }

    return c.json({
      success: true,
      message: `Mutasi stok ${transferCode} berhasil dikirim`,
      data: newTransfer,
    }, 201);
  } catch (error: any) {
    if (error instanceof TenantSecurityError) {
      return c.json({ success: false, message: error.message }, error.statusCode as any);
    }
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    return c.json({ success: false, message: 'Gagal membuat transfer stok', error: error.message }, 500);
  }
});

// 3. UPDATE STATUS (COMPLETED / CANCELLED)
router.put('/:id/status', requireRole(['owner', 'super_admin', 'pharmacist', 'inventory']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const { status } = await c.req.json();

    const [updated] = await db
      .update(stockTransfers)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(stockTransfers.id, id), eq(stockTransfers.tenantId, tenantId)))
      .returning();

    return c.json({ success: true, message: `Status mutasi diubah menjadi ${status}`, data: updated });
  } catch (error: any) {
    return c.json({ success: false, message: 'Gagal memperbarui status mutasi', error: error.message }, 500);
  }
});

export default router;
