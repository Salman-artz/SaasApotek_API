import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { db } from '../db/index';
import {
  defectaItems,
  products,
  productBatches,
  suppliers,
  purchaseOrders,
  purchaseInvoices,
} from '../db/schema/index';
import { eq, and, desc, sql } from 'drizzle-orm';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

// 1. GET DEFECTA LIST (WITH AUTO-DETECTION OF LOW STOCK)
router.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const outletId = query.outletId?.trim();

    // Query active defecta items
    const rows = await db
      .select({
        id: defectaItems.id,
        productId: defectaItems.productId,
        productName: products.name,
        category: products.category,
        baseUnit: products.baseUnit,
        supplierId: defectaItems.supplierId,
        supplierName: suppliers.name,
        currentStock: defectaItems.currentStock,
        minStock: defectaItems.minStock,
        suggestedQty: defectaItems.suggestedQty,
        priority: defectaItems.priority,
        status: defectaItems.status,
        notes: defectaItems.notes,
        createdAt: defectaItems.createdAt,
      })
      .from(defectaItems)
      .innerJoin(products, eq(defectaItems.productId, products.id))
      .leftJoin(suppliers, eq(defectaItems.supplierId, suppliers.id))
      .where(and(eq(defectaItems.tenantId, tenantId), eq(defectaItems.status, 'PENDING')))
      .orderBy(desc(defectaItems.priority), desc(defectaItems.createdAt));

    return c.json({
      success: true,
      data: rows,
      total: rows.length,
    });
  } catch (error: any) {
    console.error('Error fetching defecta items:', error);
    return c.json({ success: false, message: 'Gagal memuat buku defecta', error: error.message }, 500);
  }
});

// 2. AUTO-SCAN & SYNC DEFECTA ITEMS (SCAN ENTIRE INVENTORY)
router.post('/sync', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({}));
    const outletId = body.outletId;

    // Fetch all active products
    const allProducts = await db
      .select({
        id: products.id,
        name: products.name,
        minStockAlert: products.minStockAlert,
      })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.isActive, true)));

    let syncedCount = 0;

    for (const prod of allProducts) {
      // Calculate current stock across batches
      const batches = await db
        .select({ stock: productBatches.stockInBaseUnit })
        .from(productBatches)
        .where(
          and(
            eq(productBatches.tenantId, tenantId),
            eq(productBatches.productId, prod.id),
            outletId ? eq(productBatches.outletId, outletId) : undefined
          )
        );

      const totalStock = batches.reduce((sum, b) => sum + (Number(b.stock) || 0), 0);
      const minStock = prod.minStockAlert || 10;

      if (totalStock <= minStock) {
        // Check if already in defecta
        const [existing] = await db
          .select()
          .from(defectaItems)
          .where(
            and(
              eq(defectaItems.tenantId, tenantId),
              eq(defectaItems.productId, prod.id),
              eq(defectaItems.status, 'PENDING')
            )
          );

        const deficit = Math.max(1, minStock * 2 - totalStock); // Reorder to 2x buffer
        const priority = totalStock === 0 ? 'CRITICAL' : 'HIGH';

        if (existing) {
          await db
            .update(defectaItems)
            .set({
              currentStock: totalStock.toString(),
              minStock: minStock.toString(),
              suggestedQty: deficit.toString(),
              priority,
              updatedAt: new Date(),
            })
            .where(eq(defectaItems.id, existing.id));
        } else {
          await db.insert(defectaItems).values({
            tenantId,
            outletId: outletId || null,
            productId: prod.id,
            currentStock: totalStock.toString(),
            minStock: minStock.toString(),
            suggestedQty: deficit.toString(),
            priority,
            status: 'PENDING',
          });
          syncedCount++;
        }
      }
    }

    return c.json({
      success: true,
      message: `Penyusunan Buku Defecta selesai. Ditemukan ${syncedCount} obat perlu restock.`,
    });
  } catch (error: any) {
    console.error('Error syncing defecta:', error);
    return c.json({ success: false, message: 'Gagal menyusun defecta', error: error.message }, 500);
  }
});

// 3. UPDATE DEFECTA ITEM
router.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json();

    const [updated] = await db
      .update(defectaItems)
      .set({
        suggestedQty: body.suggestedQty?.toString(),
        supplierId: body.supplierId || null,
        priority: body.priority,
        notes: body.notes,
        updatedAt: new Date(),
      })
      .where(and(eq(defectaItems.id, id), eq(defectaItems.tenantId, tenantId)))
      .returning();

    return c.json({ success: true, message: 'Defecta item diperbarui', data: updated });
  } catch (error: any) {
    return c.json({ success: false, message: 'Gagal memperbarui defecta', error: error.message }, 500);
  }
});

// 4. GENERATE SURAT PESANAN (SP) DIRECTLY FROM DEFECTA
const generateSpSchema = z.object({
  defectaIds: z.array(z.string()).min(1, 'Pilih minimal 1 item defecta'),
  supplierId: z.string().uuid('Pilih Supplier / PBF tujuan'),
  orderType: z.enum(['REGULER', 'PREKURSOR', 'OOT', 'PSIKOTROPIKA', 'NARKOTIKA']).default('REGULER'),
  notes: z.string().optional(),
});

router.post('/generate-sp', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const body = await c.req.json();
    const { defectaIds, supplierId, orderType, notes } = generateSpSchema.parse(body);

    const poNumber = `SP-${orderType.slice(0, 3)}-${Date.now().toString().slice(-6)}`;

    // Create Purchase Order
    const [newPo] = await db
      .insert(purchaseOrders)
      .values({
        tenantId,
        outletId: user.outletId || null,
        supplierId,
        poNumber,
        orderType,
        status: 'SUBMITTED',
        orderDate: new Date().toISOString().split('T')[0],
        notes: notes || 'Otomatis dibuat dari Buku Defecta AI',
        createdById: user.id,
      })
      .returning();

    // Mark selected defecta items as ORDERED
    for (const dId of defectaIds) {
      await db
        .update(defectaItems)
        .set({ status: 'ORDERED', updatedAt: new Date() })
        .where(and(eq(defectaItems.id, dId), eq(defectaItems.tenantId, tenantId)));
    }

    return c.json({
      success: true,
      message: `Surat Pesanan ${poNumber} berhasil diterbitkan`,
      data: newPo,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    console.error('Error generating SP from defecta:', error);
    return c.json({ success: false, message: 'Gagal membuat Surat Pesanan', error: error.message }, 500);
  }
});

// 5. DELETE DEFECTA ITEM
router.delete('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');

    await db
      .delete(defectaItems)
      .where(and(eq(defectaItems.id, id), eq(defectaItems.tenantId, tenantId)));

    return c.json({ success: true, message: 'Item dihapus dari defecta' });
  } catch (error: any) {
    return c.json({ success: false, message: 'Gagal menghapus item defecta', error: error.message }, 500);
  }
});

export default router;
