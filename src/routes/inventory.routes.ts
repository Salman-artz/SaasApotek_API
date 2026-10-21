import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { db } from '../db/index';
import {
  products,
  productBatches,
  stockMutations,
  stockOpnames,
  stockOpnameItems,
  outlets,
  users,
} from '../db/schema/index';
import { eq, and, or, ilike, sql, desc, asc, lte, gte } from 'drizzle-orm';
import {
  assertOutletBelongsToTenant,
  assertProductsBelongToTenant,
  TenantSecurityError,
} from '../lib/tenant-validator';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

// Helper function to calculate expiry status & days left
function getExpiryInfo(expiredDateStr: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expDate = new Date(expiredDateStr);
  expDate.setHours(0, 0, 0, 0);

  const diffTime = expDate.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  let status: 'EXPIRED' | 'CRITICAL_3M' | 'WARNING_6M' | 'SAFE' = 'SAFE';
  if (diffDays <= 0) {
    status = 'EXPIRED';
  } else if (diffDays <= 90) {
    status = 'CRITICAL_3M';
  } else if (diffDays <= 180) {
    status = 'WARNING_6M';
  }

  return { diffDays, status };
}

// 1. LIST BATCHES (FEFO VIEW)
router.get('/batches', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const search = query.search?.trim();
    const outletId = query.outletId?.trim();
    const statusFilter = query.status?.trim(); // 'EXPIRED', 'CRITICAL_3M', 'WARNING_6M', 'SAFE', 'ALL'
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [
      eq(productBatches.tenantId, tenantId),
      eq(products.isActive, true),
    ];

    if (outletId) {
      conditions.push(eq(productBatches.outletId, outletId));
    }

    if (search) {
      conditions.push(
        or(
          ilike(products.name, `%${search}%`),
          ilike(products.sku, `%${search}%`),
          ilike(products.barcode, `%${search}%`),
          ilike(productBatches.batchNumber, `%${search}%`)
        )!
      );
    }

    // FEFO sorting: Expired date ascending
    const allMatching = await db
      .select({
        id: productBatches.id,
        productId: productBatches.productId,
        productName: products.name,
        productSku: products.sku,
        productBarcode: products.barcode,
        baseUnit: products.baseUnit,
        category: products.category,
        outletId: productBatches.outletId,
        outletName: outlets.name,
        batchNumber: productBatches.batchNumber,
        expiredDate: productBatches.expiredDate,
        stockInBaseUnit: productBatches.stockInBaseUnit,
        costPerBaseUnit: productBatches.costPerBaseUnit,
        createdAt: productBatches.createdAt,
      })
      .from(productBatches)
      .innerJoin(products, eq(productBatches.productId, products.id))
      .innerJoin(outlets, eq(productBatches.outletId, outlets.id))
      .where(and(...conditions))
      .orderBy(asc(productBatches.expiredDate));

    // Calculate expiry status for each batch
    const enriched = allMatching.map((batch) => {
      const { diffDays, status } = getExpiryInfo(batch.expiredDate);
      const stock = Number(batch.stockInBaseUnit || 0);
      const cost = Number(batch.costPerBaseUnit || 0);
      const estimatedValue = stock * cost;

      return {
        ...batch,
        daysUntilExpiry: diffDays,
        expiryStatus: status,
        estimatedValue,
      };
    });

    // Filter by status if requested
    const filtered = statusFilter && statusFilter !== 'ALL'
      ? enriched.filter((b) => b.expiryStatus === statusFilter)
      : enriched;

    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    return c.json({
      success: true,
      data: paginated,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('Error fetching inventory batches:', error);
    return c.json({ success: false, message: 'Gagal mengambil data batch obat', error: error.message }, 500);
  }
});

// 2. EXPIRY RADAR KPI & SUMMARY
router.get('/expiry-radar', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const outletId = query.outletId?.trim();

    const conditions = [
      eq(productBatches.tenantId, tenantId),
      eq(products.isActive, true),
      sql`${productBatches.stockInBaseUnit} > 0`,
    ];

    if (outletId) {
      conditions.push(eq(productBatches.outletId, outletId));
    }

    const batches = await db
      .select({
        id: productBatches.id,
        expiredDate: productBatches.expiredDate,
        stockInBaseUnit: productBatches.stockInBaseUnit,
        costPerBaseUnit: productBatches.costPerBaseUnit,
      })
      .from(productBatches)
      .innerJoin(products, eq(productBatches.productId, products.id))
      .where(and(...conditions));

    let expiredCount = 0;
    let expiredValue = 0;
    let criticalCount = 0;
    let criticalValue = 0;
    let warningCount = 0;
    let warningValue = 0;
    let safeCount = 0;
    let safeValue = 0;

    for (const b of batches) {
      const { status } = getExpiryInfo(b.expiredDate);
      const stock = Number(b.stockInBaseUnit || 0);
      const cost = Number(b.costPerBaseUnit || 0);
      const val = stock * cost;

      if (status === 'EXPIRED') {
        expiredCount++;
        expiredValue += val;
      } else if (status === 'CRITICAL_3M') {
        criticalCount++;
        criticalValue += val;
      } else if (status === 'WARNING_6M') {
        warningCount++;
        warningValue += val;
      } else {
        safeCount++;
        safeValue += val;
      }
    }

    return c.json({
      success: true,
      data: {
        totalBatchesWithStock: batches.length,
        totalAssetValue: expiredValue + criticalValue + warningValue + safeValue,
        totalAtRiskValue: expiredValue + criticalValue,
        expired: {
          count: expiredCount,
          value: expiredValue,
        },
        critical: {
          count: criticalCount,
          value: criticalValue,
        },
        warning: {
          count: warningCount,
          value: warningValue,
        },
        safe: {
          count: safeCount,
          value: safeValue,
        },
      },
    });
  } catch (error: any) {
    console.error('Error calculating expiry radar:', error);
    return c.json({ success: false, message: 'Gagal memuat radar kedaluwarsa', error: error.message }, 500);
  }
});

// 3. CREATE MANUAL / INITIAL BATCH
const createBatchSchema = z.object({
  productId: z.string().uuid(),
  outletId: z.string().uuid(),
  batchNumber: z.string().min(1, 'Nomor batch wajib diisi'),
  expiredDate: z.string().min(1, 'Tanggal kedaluwarsa wajib diisi'),
  stockInBaseUnit: z.number().int().min(0, 'Stok minimal 0'),
  costPerBaseUnit: z.number().min(0, 'Harga pokok minimal 0').default(0),
  notes: z.string().optional(),
});

router.post('/batches', requireRole(['owner', 'super_admin', 'pharmacist', 'inventory']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const body = await c.req.json();
    const validated = createBatchSchema.parse(body);

    const result = await db.transaction(async (tx) => {
      // 1. Create the batch
      const [newBatch] = await tx
        .insert(productBatches)
        .values({
          tenantId,
          outletId: validated.outletId,
          productId: validated.productId,
          batchNumber: validated.batchNumber,
          expiredDate: validated.expiredDate,
          stockInBaseUnit: validated.stockInBaseUnit,
          costPerBaseUnit: validated.costPerBaseUnit.toString(),
        })
        .returning();

      // 2. Calculate current total product stock across batches in this outlet
      const currentBatches = await tx
        .select({ stock: productBatches.stockInBaseUnit })
        .from(productBatches)
        .where(
          and(
            eq(productBatches.tenantId, tenantId),
            eq(productBatches.outletId, validated.outletId),
            eq(productBatches.productId, validated.productId)
          )
        );

      const totalStock = currentBatches.reduce((acc, curr) => acc + (curr.stock || 0), 0);

      // 3. Log stock mutation
      if (validated.stockInBaseUnit > 0) {
        await tx.insert(stockMutations).values({
          tenantId,
          outletId: validated.outletId,
          productId: validated.productId,
          batchId: newBatch.id,
          type: 'INITIAL',
          referenceType: 'MANUAL',
          referenceNumber: `INIT-${validated.batchNumber}`,
          qtyIn: validated.stockInBaseUnit,
          qtyOut: 0,
          balanceAfter: totalStock,
          notes: validated.notes || 'Stok awal batch manual',
          createdBy: user.id,
        });
      }

      return newBatch;
    });

    return c.json({
      success: true,
      message: 'Batch obat berhasil ditambahkan',
      data: result,
    }, 201);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    console.error('Error creating batch:', error);
    return c.json({ success: false, message: 'Gagal menambahkan batch obat', error: error.message }, 500);
  }
});

// 4. QUICK STOCK ADJUSTMENT (+ / -)
const adjustmentSchema = z.object({
  batchId: z.string().uuid(),
  type: z.enum(['ADJUSTMENT_IN', 'ADJUSTMENT_OUT']),
  qty: z.number().int().positive('Jumlah penyesuaian harus lebih dari 0'),
  notes: z.string().min(1, 'Alasan penyesuaian wajib diisi'),
});

router.post('/adjustments', requireRole(['owner', 'super_admin', 'pharmacist', 'inventory']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const body = await c.req.json();
    const validated = adjustmentSchema.parse(body);

    const result = await db.transaction(async (tx) => {
      // Find batch
      const [batch] = await tx
        .select()
        .from(productBatches)
        .where(
          and(
            eq(productBatches.id, validated.batchId),
            eq(productBatches.tenantId, tenantId)
          )
        );

      if (!batch) {
        throw new Error('Batch obat tidak ditemukan');
      }

      const currentBatchStock = batch.stockInBaseUnit || 0;
      let newBatchStock = currentBatchStock;

      if (validated.type === 'ADJUSTMENT_IN') {
        newBatchStock += validated.qty;
      } else {
        if (currentBatchStock < validated.qty) {
          throw new Error(`Stok batch (${currentBatchStock}) tidak mencukupi untuk pengurangan ${validated.qty}`);
        }
        newBatchStock -= validated.qty;
      }

      // Update batch stock
      await tx
        .update(productBatches)
        .set({ stockInBaseUnit: newBatchStock })
        .where(eq(productBatches.id, batch.id));

      // Calculate new total product stock for outlet
      const allBatches = await tx
        .select({ stock: productBatches.stockInBaseUnit })
        .from(productBatches)
        .where(
          and(
            eq(productBatches.tenantId, tenantId),
            eq(productBatches.outletId, batch.outletId),
            eq(productBatches.productId, batch.productId)
          )
        );

      const totalStock = allBatches.reduce((acc, curr) => acc + (curr.stock || 0), 0);

      // Record stock mutation
      const [mutation] = await tx
        .insert(stockMutations)
        .values({
          tenantId,
          outletId: batch.outletId,
          productId: batch.productId,
          batchId: batch.id,
          type: validated.type,
          referenceType: 'MANUAL_ADJUSTMENT',
          referenceNumber: `ADJ-${Date.now().toString().slice(-6)}`,
          qtyIn: validated.type === 'ADJUSTMENT_IN' ? validated.qty : 0,
          qtyOut: validated.type === 'ADJUSTMENT_OUT' ? validated.qty : 0,
          balanceAfter: totalStock,
          notes: validated.notes,
          createdBy: user.id,
        })
        .returning();

      return {
        batchId: batch.id,
        newBatchStock,
        totalProductStock: totalStock,
        mutation,
      };
    });

    return c.json({
      success: true,
      message: 'Penyesuaian stok berhasil disimpan',
      data: result,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    console.error('Error adjusting stock:', error);
    return c.json({ success: false, message: error.message || 'Gagal menyesuaikan stok' }, 400);
  }
});

// 5. KARTU STOK (AUDIT TRAIL MUTATIONS)
router.get('/stock-cards', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const productId = query.productId?.trim();
    const outletId = query.outletId?.trim();
    const batchId = query.batchId?.trim();
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [eq(stockMutations.tenantId, tenantId)];

    if (productId) {
      conditions.push(eq(stockMutations.productId, productId));
    }
    if (outletId) {
      conditions.push(eq(stockMutations.outletId, outletId));
    }
    if (batchId) {
      conditions.push(eq(stockMutations.batchId, batchId));
    }

    const whereClause = and(...conditions);

    // Total count
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(stockMutations)
      .where(whereClause);

    const total = countResult?.count || 0;

    // Mutasi list with joins
    const mutations = await db
      .select({
        id: stockMutations.id,
        productId: stockMutations.productId,
        productName: products.name,
        productSku: products.sku,
        baseUnit: products.baseUnit,
        batchId: stockMutations.batchId,
        batchNumber: productBatches.batchNumber,
        expiredDate: productBatches.expiredDate,
        outletId: stockMutations.outletId,
        outletName: outlets.name,
        type: stockMutations.type,
        referenceType: stockMutations.referenceType,
        referenceNumber: stockMutations.referenceNumber,
        qtyIn: stockMutations.qtyIn,
        qtyOut: stockMutations.qtyOut,
        balanceAfter: stockMutations.balanceAfter,
        notes: stockMutations.notes,
        userName: users.fullName,
        createdAt: stockMutations.createdAt,
      })
      .from(stockMutations)
      .innerJoin(products, eq(stockMutations.productId, products.id))
      .innerJoin(outlets, eq(stockMutations.outletId, outlets.id))
      .leftJoin(productBatches, eq(stockMutations.batchId, productBatches.id))
      .leftJoin(users, eq(stockMutations.createdBy, users.id))
      .where(whereClause)
      .orderBy(desc(stockMutations.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      success: true,
      data: mutations,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('Error fetching stock cards:', error);
    return c.json({ success: false, message: 'Gagal memuat kartu stok', error: error.message }, 500);
  }
});

// 6. STOCK OPNAME SESSIONS
router.get('/opnames', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const outletId = query.outletId?.trim();
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [eq(stockOpnames.tenantId, tenantId)];
    if (outletId) {
      conditions.push(eq(stockOpnames.outletId, outletId));
    }

    const whereClause = and(...conditions);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(stockOpnames)
      .where(whereClause);

    const total = countResult?.count || 0;

    const sessions = await db
      .select({
        id: stockOpnames.id,
        opnameNumber: stockOpnames.opnameNumber,
        status: stockOpnames.status,
        totalItems: stockOpnames.totalItems,
        totalVariance: stockOpnames.totalVariance,
        notes: stockOpnames.notes,
        outletId: stockOpnames.outletId,
        outletName: outlets.name,
        conductedBy: stockOpnames.conductedBy,
        conductorName: users.fullName,
        createdAt: stockOpnames.createdAt,
      })
      .from(stockOpnames)
      .innerJoin(outlets, eq(stockOpnames.outletId, outlets.id))
      .leftJoin(users, eq(stockOpnames.conductedBy, users.id))
      .where(whereClause)
      .orderBy(desc(stockOpnames.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      success: true,
      data: sessions,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('Error fetching opnames:', error);
    return c.json({ success: false, message: 'Gagal mengambil riwayat stock opname', error: error.message }, 500);
  }
});

// 7. GET OPNAME DETAIL WITH ITEMS
router.get('/opnames/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const opnameId = c.req.param('id');

    const [session] = await db
      .select({
        id: stockOpnames.id,
        opnameNumber: stockOpnames.opnameNumber,
        status: stockOpnames.status,
        totalItems: stockOpnames.totalItems,
        totalVariance: stockOpnames.totalVariance,
        notes: stockOpnames.notes,
        outletId: stockOpnames.outletId,
        outletName: outlets.name,
        conductedBy: stockOpnames.conductedBy,
        conductorName: users.fullName,
        createdAt: stockOpnames.createdAt,
      })
      .from(stockOpnames)
      .innerJoin(outlets, eq(stockOpnames.outletId, outlets.id))
      .leftJoin(users, eq(stockOpnames.conductedBy, users.id))
      .where(and(eq(stockOpnames.id, opnameId), eq(stockOpnames.tenantId, tenantId)));

    if (!session) {
      return c.json({ success: false, message: 'Sesi stock opname tidak ditemukan' }, 404);
    }

    const items = await db
      .select({
        id: stockOpnameItems.id,
        productId: stockOpnameItems.productId,
        productName: products.name,
        productSku: products.sku,
        baseUnit: products.baseUnit,
        batchId: stockOpnameItems.batchId,
        batchNumber: productBatches.batchNumber,
        expiredDate: productBatches.expiredDate,
        systemStock: stockOpnameItems.systemStock,
        physicalStock: stockOpnameItems.physicalStock,
        variance: stockOpnameItems.variance,
        reason: stockOpnameItems.reason,
      })
      .from(stockOpnameItems)
      .innerJoin(products, eq(stockOpnameItems.productId, products.id))
      .leftJoin(productBatches, eq(stockOpnameItems.batchId, productBatches.id))
      .where(eq(stockOpnameItems.opnameId, opnameId));

    return c.json({
      success: true,
      data: {
        ...session,
        items,
      },
    });
  } catch (error: any) {
    console.error('Error fetching opname detail:', error);
    return c.json({ success: false, message: 'Gagal memuat detail stock opname', error: error.message }, 500);
  }
});

// 8. SUBMIT STOCK OPNAME
const opnameSubmitSchema = z.object({
  outletId: z.string().uuid(),
  notes: z.string().optional(),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      batchId: z.string().uuid().optional().nullable(),
      systemStock: z.number().int(),
      physicalStock: z.number().int().min(0, 'Stok fisik tidak boleh negatif'),
      reason: z.string().optional(),
    })
  ).min(1, 'Minimal 1 item untuk stock opname'),
});

router.post('/opnames', requireRole(['owner', 'super_admin', 'pharmacist', 'inventory']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const body = await c.req.json();
    const validated = opnameSubmitSchema.parse(body);

    // Cross-Tenant IDOR Protection
    await assertOutletBelongsToTenant(db, validated.outletId, tenantId);
    await assertProductsBelongToTenant(db, validated.items.map((i) => i.productId), tenantId);

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const opnameNumber = `SO-${dateStr}-${randomSuffix}`;

    const totalItems = validated.items.length;
    const totalVariance = validated.items.reduce(
      (sum, item) => sum + (item.physicalStock - item.systemStock),
      0
    );

    const result = await db.transaction(async (tx) => {
      // 1. Insert header
      const [opnameHeader] = await tx
        .insert(stockOpnames)
        .values({
          tenantId,
          outletId: validated.outletId,
          opnameNumber,
          status: 'COMPLETED',
          totalItems,
          totalVariance,
          notes: validated.notes || 'Hasil Stock Opname Fisik',
          conductedBy: user.id,
        })
        .returning();

      // 2. Process items
      for (const item of validated.items) {
        const variance = item.physicalStock - item.systemStock;

        // Insert opname item
        await tx.insert(stockOpnameItems).values({
          opnameId: opnameHeader.id,
          productId: item.productId,
          batchId: item.batchId || null,
          systemStock: item.systemStock,
          physicalStock: item.physicalStock,
          variance,
          reason: item.reason || (variance === 0 ? 'Sesuai' : 'Penyesuaian Opname'),
        });

        // If batch exists, update batch stock & record mutation
        if (item.batchId && variance !== 0) {
          // Update batch stock to physical stock
          await tx
            .update(productBatches)
            .set({ stockInBaseUnit: item.physicalStock })
            .where(
              and(
                eq(productBatches.id, item.batchId),
                eq(productBatches.tenantId, tenantId)
              )
            );

          // Calculate new total product stock
          const allBatches = await tx
            .select({ stock: productBatches.stockInBaseUnit })
            .from(productBatches)
            .where(
              and(
                eq(productBatches.tenantId, tenantId),
                eq(productBatches.outletId, validated.outletId),
                eq(productBatches.productId, item.productId)
              )
            );

          const totalStock = allBatches.reduce((acc, curr) => acc + (curr.stock || 0), 0);

          // Record stock mutation
          await tx.insert(stockMutations).values({
            tenantId,
            outletId: validated.outletId,
            productId: item.productId,
            batchId: item.batchId,
            type: 'OPNAME',
            referenceType: 'STOCK_OPNAME',
            referenceNumber: opnameNumber,
            qtyIn: variance > 0 ? variance : 0,
            qtyOut: variance < 0 ? Math.abs(variance) : 0,
            balanceAfter: totalStock,
            notes: item.reason || `Penyesuaian Opname #${opnameNumber} (Selisih: ${variance > 0 ? '+' : ''}${variance})`,
            createdBy: user.id,
          });
        }
      }

      return opnameHeader;
    });

    return c.json({
      success: true,
      message: `Stock Opname ${opnameNumber} berhasil disimpan dan stok disinkronisasi.`,
      data: result,
    }, 201);
  } catch (error: any) {
    if (error instanceof TenantSecurityError) {
      return c.json({ success: false, message: error.message }, error.statusCode as any);
    }
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    console.error('Error submitting stock opname:', error);
    return c.json({ success: false, message: error.message || 'Gagal menyimpan stock opname' }, 500);
  }
});

export default router;
