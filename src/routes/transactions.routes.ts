import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { db } from '../db/index';
import {
  transactions,
  transactionItems,
  shiftSessions,
  products,
  productUnits,
  productBatches,
  stockMutations,
  outlets,
  users,
} from '../db/schema/index';
import { eq, and, or, ilike, sql, desc, asc, gte, lte, inArray } from 'drizzle-orm';
import {
  assertOutletBelongsToTenant,
  assertProductsBelongToTenant,
  assertShiftBelongsToTenant,
  TenantSecurityError,
} from '../lib/tenant-validator';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

// =========================================================================
// 1. SHIFT KASIR MANAGEMENT
// =========================================================================

// GET CURRENT ACTIVE SHIFT FOR LOGGED IN CASHIER
router.get('/shifts/current', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const query = c.req.query();
    const outletId = query.outletId?.trim();

    const conditions = [
      eq(shiftSessions.tenantId, tenantId),
      eq(shiftSessions.cashierId, user.id),
      eq(shiftSessions.status, 'open'),
    ];

    if (outletId) {
      conditions.push(eq(shiftSessions.outletId, outletId));
    }

    const [activeShift] = await db
      .select({
        id: shiftSessions.id,
        tenantId: shiftSessions.tenantId,
        outletId: shiftSessions.outletId,
        outletName: outlets.name,
        cashierId: shiftSessions.cashierId,
        cashierName: users.fullName,
        openedAt: shiftSessions.openedAt,
        openingCash: shiftSessions.openingCash,
        status: shiftSessions.status,
        notes: shiftSessions.notes,
      })
      .from(shiftSessions)
      .innerJoin(outlets, eq(shiftSessions.outletId, outlets.id))
      .innerJoin(users, eq(shiftSessions.cashierId, users.id))
      .where(and(...conditions))
      .orderBy(desc(shiftSessions.openedAt))
      .limit(1);

    if (!activeShift) {
      return c.json({ success: true, data: null, message: 'Tidak ada sesi kasir yang aktif' });
    }

    // Calculate current shift sales summary
    const shiftTransactions = await db
      .select({
        paymentMethod: transactions.paymentMethod,
        grandTotal: transactions.grandTotal,
        paidAmount: transactions.paidAmount,
      })
      .from(transactions)
      .where(eq(transactions.shiftSessionId, activeShift.id));

    let cashSales = 0;
    let nonCashSales = 0;
    let totalTransactions = shiftTransactions.length;

    for (const t of shiftTransactions) {
      const val = Number(t.grandTotal || 0);
      if (t.paymentMethod === 'cash') {
        cashSales += val;
      } else {
        nonCashSales += val;
      }
    }

    const expectedCash = Number(activeShift.openingCash || 0) + cashSales;

    return c.json({
      success: true,
      data: {
        ...activeShift,
        summary: {
          totalTransactions,
          cashSales,
          nonCashSales,
          totalSales: cashSales + nonCashSales,
          expectedCash,
        },
      },
    });
  } catch (error: any) {
    console.error('Error fetching current shift:', error);
    return c.json({ success: false, message: 'Gagal memeriksa sesi kasir', error: error.message }, 500);
  }
});

// OPEN SHIFT KASIR
const openShiftSchema = z.object({
  outletId: z.string().uuid(),
  openingCash: z.number().min(0, 'Modal kasir minimal Rp 0').default(0),
  notes: z.string().optional(),
});

router.post('/shifts/open', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const body = await c.req.json();
    const validated = openShiftSchema.parse(body);

    // Cross-Tenant IDOR Protection
    await assertOutletBelongsToTenant(db, validated.outletId, tenantId);

    // Check if cashier already has an open shift in this outlet
    const [existing] = await db
      .select()
      .from(shiftSessions)
      .where(
        and(
          eq(shiftSessions.tenantId, tenantId),
          eq(shiftSessions.outletId, validated.outletId),
          eq(shiftSessions.cashierId, user.id),
          eq(shiftSessions.status, 'open')
        )
      );

    if (existing) {
      return c.json({
        success: true,
        message: 'Shift kasir sudah aktif',
        data: existing,
      });
    }

    const [newShift] = await db
      .insert(shiftSessions)
      .values({
        tenantId,
        outletId: validated.outletId,
        cashierId: user.id,
        openingCash: validated.openingCash.toString(),
        status: 'open',
        notes: validated.notes || 'Buka shift kasir',
      })
      .returning();

    return c.json({
      success: true,
      message: 'Shift kasir berhasil dibuka',
      data: newShift,
    }, 201);
  } catch (error: any) {
    if (error instanceof TenantSecurityError) {
      return c.json({ success: false, message: error.message }, error.statusCode as any);
    }
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    console.error('Error opening shift:', error);
    return c.json({ success: false, message: 'Gagal membuka shift kasir', error: error.message }, 500);
  }
});

// CLOSE SHIFT KASIR
const closeShiftSchema = z.object({
  closingCash: z.number().min(0, 'Uang fisik penutupan kasir harus diisi'),
  notes: z.string().optional(),
});

router.post('/shifts/close', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const body = await c.req.json();
    const validated = closeShiftSchema.parse(body);

    // Find active shift
    const [shift] = await db
      .select()
      .from(shiftSessions)
      .where(
        and(
          eq(shiftSessions.tenantId, tenantId),
          eq(shiftSessions.cashierId, user.id),
          eq(shiftSessions.status, 'open')
        )
      )
      .orderBy(desc(shiftSessions.openedAt))
      .limit(1);

    if (!shift) {
      return c.json({ success: false, message: 'Tidak ada shift kasir yang sedang aktif' }, 404);
    }

    // Calculate cash transactions in this shift
    const shiftTransactions = await db
      .select({
        grandTotal: transactions.grandTotal,
        paymentMethod: transactions.paymentMethod,
      })
      .from(transactions)
      .where(eq(transactions.shiftSessionId, shift.id));

    let cashSales = 0;
    let nonCashSales = 0;

    for (const t of shiftTransactions) {
      const val = Number(t.grandTotal || 0);
      if (t.paymentMethod === 'cash') {
        cashSales += val;
      } else {
        nonCashSales += val;
      }
    }

    const openingCash = Number(shift.openingCash || 0);
    const expectedCash = openingCash + cashSales;
    const cashDifference = validated.closingCash - expectedCash;

    const [closedShift] = await db
      .update(shiftSessions)
      .set({
        status: 'closed',
        closedAt: new Date(),
        closingCash: validated.closingCash.toString(),
        expectedCash: expectedCash.toString(),
        cashDifference: cashDifference.toString(),
        notes: validated.notes || shift.notes,
      })
      .where(eq(shiftSessions.id, shift.id))
      .returning();

    return c.json({
      success: true,
      message: 'Shift kasir berhasil ditutup',
      data: {
        ...closedShift,
        summary: {
          totalTransactions: shiftTransactions.length,
          openingCash,
          cashSales,
          nonCashSales,
          totalSales: cashSales + nonCashSales,
          expectedCash,
          actualCash: validated.closingCash,
          difference: cashDifference,
        },
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    console.error('Error closing shift:', error);
    return c.json({ success: false, message: 'Gagal menutup shift kasir', error: error.message }, 500);
  }
});


// =========================================================================
// 2. CREATE POS TRANSACTION (ACID + AUTO FEFO BATCH DEDUCTION)
// =========================================================================

const createTransactionSchema = z.object({
  outletId: z.string().uuid(),
  shiftSessionId: z.string().uuid().optional().nullable(),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  doctorName: z.string().optional(),
  prescriptionNumber: z.string().optional(),
  isPrescription: z.boolean().default(false),
  tuslahFee: z.number().min(0).default(0),
  discountAmount: z.number().min(0).default(0),
  taxAmount: z.number().min(0).default(0),
  paymentMethod: z.enum(['cash', 'qris', 'transfer', 'debit']),
  paidAmount: z.number().min(0, 'Uang bayar tidak boleh negatif'),
  notes: z.string().optional(),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      unitId: z.string().uuid(),
      quantity: z.number().int().positive('Jumlah obat harus > 0'),
      unitPrice: z.number().min(0, 'Harga obat tidak boleh negatif').optional(),
      discountPerItem: z.number().min(0).default(0),
      batchId: z.string().uuid().optional().nullable(),
      isRacikan: z.boolean().default(false),
      racikanName: z.string().optional(),
      signa: z.string().optional(),
    })
  ).min(1, 'Minimal 1 item obat dalam transaksi'),
});

router.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const body = await c.req.json();
    const validated = createTransactionSchema.parse(body);

    // Cross-Tenant IDOR Protection
    await assertOutletBelongsToTenant(db, validated.outletId, tenantId);
    if (validated.shiftSessionId) {
      await assertShiftBelongsToTenant(db, validated.shiftSessionId, tenantId);
    }
    await assertProductsBelongToTenant(db, validated.items.map((i) => i.productId), tenantId);

    // Authoritative Server-Side Pricing: Fetch units from DB to prevent client-side price tampering
    const unitIds = Array.from(new Set(validated.items.map((i) => i.unitId)));
    const dbUnits = await db
      .select()
      .from(productUnits)
      .where(inArray(productUnits.id, unitIds));

    const unitMap = new Map(dbUnits.map((u) => [u.id, u]));

    let totalSubtotal = 0;
    const verifiedItems = validated.items.map((item) => {
      const dbUnit = unitMap.get(item.unitId);
      if (!dbUnit || dbUnit.productId !== item.productId) {
        throw new Error(`Satuan produk tidak valid untuk item ID: ${item.productId}`);
      }
      const verifiedUnitPrice = Number(dbUnit.sellPrice || 0);
      const discount = Math.max(0, item.discountPerItem || 0);
      // Cap discount so item cannot have negative total
      const effectiveDiscount = Math.min(discount, verifiedUnitPrice * item.quantity);
      const itemSubtotal = (verifiedUnitPrice * item.quantity) - effectiveDiscount;
      totalSubtotal += itemSubtotal;

      return {
        ...item,
        verifiedUnitPrice,
        effectiveDiscount,
        itemSubtotal,
        conversionFactor: dbUnit.conversionFactor || 1,
        unitName: dbUnit.unitName,
      };
    });

    totalSubtotal += validated.tuslahFee;

    const now = new Date();
    const dateStr = now.toISOString().slice(2, 10).replace(/-/g, '');
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const invoiceCode = `INV-${dateStr}-${randomSuffix}`;

    const grandTotal = Math.max(0, totalSubtotal - validated.discountAmount + validated.taxAmount);

    if (validated.paymentMethod === 'cash' && validated.paidAmount < grandTotal) {
      return c.json({
        success: false,
        message: `Uang pembayaran (Rp ${validated.paidAmount}) kurang dari total belanja (Rp ${grandTotal})`,
      }, 400);
    }

    const changeAmount = validated.paymentMethod === 'cash' ? Math.max(0, validated.paidAmount - grandTotal) : 0;

    const result = await db.transaction(async (tx) => {
      // 1. Insert transaction header
      const [newTransaction] = await tx
        .insert(transactions)
        .values({
          tenantId,
          outletId: validated.outletId,
          cashierId: user.id,
          shiftSessionId: validated.shiftSessionId || null,
          invoiceCode,
          customerName: validated.customerName || 'Pelanggan Umum',
          customerPhone: validated.customerPhone,
          doctorName: validated.doctorName,
          prescriptionNumber: validated.prescriptionNumber,
          isPrescription: validated.isPrescription,
          tuslahFee: validated.tuslahFee.toString(),
          totalSubtotal: totalSubtotal.toString(),
          discountAmount: validated.discountAmount.toString(),
          taxAmount: validated.taxAmount.toString(),
          grandTotal: grandTotal.toString(),
          paidAmount: (validated.paymentMethod === 'cash' ? validated.paidAmount : grandTotal).toString(),
          changeAmount: changeAmount.toString(),
          paymentMethod: validated.paymentMethod,
          paymentStatus: 'completed',
          notes: validated.notes,
        })
        .returning();

      // 2. Process items with FEFO batch deduction
      const createdItems = [];

      for (const item of verifiedItems) {
        const conversionFactor = item.conversionFactor || 1;
        const totalBaseQtyNeeded = item.quantity * conversionFactor;

        // Fetch product info for log
        const [prod] = await tx
          .select()
          .from(products)
          .where(eq(products.id, item.productId));

        const productName = prod?.name || 'Obat';

        // Check if manual batch was provided
        if (item.batchId) {
          const [manualBatch] = await tx
            .select()
            .from(productBatches)
            .where(
              and(
                eq(productBatches.id, item.batchId),
                eq(productBatches.tenantId, tenantId),
                eq(productBatches.outletId, validated.outletId)
              )
            )
            .for('update');

          if (!manualBatch || (manualBatch.stockInBaseUnit || 0) < totalBaseQtyNeeded) {
            throw new Error(
              `Stok batch untuk obat "${productName}" tidak mencukupi (tersedia: ${manualBatch?.stockInBaseUnit || 0}, dibutuhkan: ${totalBaseQtyNeeded} ${prod?.baseUnit || ''})`
            );
          }

          // Deduct batch atomically with barrier
          const [updatedBatch] = await tx
            .update(productBatches)
            .set({
              stockInBaseUnit: sql`${productBatches.stockInBaseUnit} - ${totalBaseQtyNeeded}`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(productBatches.id, manualBatch.id),
                gte(productBatches.stockInBaseUnit, totalBaseQtyNeeded)
              )
            )
            .returning();

          if (!updatedBatch) {
            throw new Error(
              `Stok batch untuk obat "${productName}" berubah saat transaksi diproses. Silakan coba lagi.`
            );
          }

          // Insert transaction item with verified server-side price
          const [createdItem] = await tx
            .insert(transactionItems)
            .values({
              transactionId: newTransaction.id,
              productId: item.productId,
              batchId: manualBatch.id,
              unitId: item.unitId,
              quantity: item.quantity,
              baseQuantityDeducted: totalBaseQtyNeeded,
              unitPrice: item.verifiedUnitPrice.toString(),
              discountPerItem: item.effectiveDiscount.toString(),
              subtotal: item.itemSubtotal.toString(),
              isRacikan: item.isRacikan || false,
              racikanName: item.racikanName,
              signa: item.signa,
            })
            .returning();
          createdItems.push(createdItem);

          // Calculate product total stock
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
          const totalStockAfter = allBatches.reduce((s, b) => s + (b.stock || 0), 0);

          // Record stock mutation
          await tx.insert(stockMutations).values({
            tenantId,
            outletId: validated.outletId,
            productId: item.productId,
            batchId: manualBatch.id,
            type: 'SALE',
            referenceType: 'POS_TRANSACTION',
            referenceNumber: invoiceCode,
            qtyIn: 0,
            qtyOut: totalBaseQtyNeeded,
            balanceAfter: totalStockAfter,
            notes: `Penjualan Kasir #${invoiceCode} (${item.quantity} ${item.unitName || 'Satuan'})`,
            createdBy: user.id,
          });
        } else {
          // AUTO FEFO ALLOCATION: Pick batches ordered by expiredDate ASC with row lock
          const availableBatches = await tx
            .select()
            .from(productBatches)
            .where(
              and(
                eq(productBatches.tenantId, tenantId),
                eq(productBatches.outletId, validated.outletId),
                eq(productBatches.productId, item.productId),
                sql`${productBatches.stockInBaseUnit} > 0`
              )
            )
            .orderBy(asc(productBatches.expiredDate))
            .for('update');

          const totalAvailable = availableBatches.reduce((s, b) => s + (b.stockInBaseUnit || 0), 0);

          if (totalAvailable < totalBaseQtyNeeded) {
            throw new Error(
              `Stok obat "${productName}" tidak mencukupi (tersedia: ${totalAvailable} ${prod?.baseUnit || ''}, dibutuhkan: ${totalBaseQtyNeeded} ${prod?.baseUnit || ''})`
            );
          }

          let remainingToDeduct = totalBaseQtyNeeded;

          for (const batch of availableBatches) {
            if (remainingToDeduct <= 0) break;

            const deductFromThis = Math.min(batch.stockInBaseUnit, remainingToDeduct);

            // Update batch stock atomically with barrier
            const [updatedBatch] = await tx
              .update(productBatches)
              .set({
                stockInBaseUnit: sql`${productBatches.stockInBaseUnit} - ${deductFromThis}`,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(productBatches.id, batch.id),
                  gte(productBatches.stockInBaseUnit, deductFromThis)
                )
              )
              .returning();

            if (!updatedBatch) {
              throw new Error(
                `Stok batch obat "${productName}" berubah saat transaksi diproses. Silakan coba lagi.`
              );
            }

            remainingToDeduct -= deductFromThis;

            // Fraction of item for this batch
            const fractionOfTotal = deductFromThis / totalBaseQtyNeeded;
            const portionQty = Math.max(1, Math.round(item.quantity * fractionOfTotal));
            const portionSubtotal = item.itemSubtotal * fractionOfTotal;

            const [createdItem] = await tx
              .insert(transactionItems)
              .values({
                transactionId: newTransaction.id,
                productId: item.productId,
                batchId: batch.id,
                unitId: item.unitId,
                quantity: portionQty,
                baseQuantityDeducted: deductFromThis,
                unitPrice: item.verifiedUnitPrice.toString(),
                discountPerItem: (item.effectiveDiscount * fractionOfTotal).toString(),
                subtotal: portionSubtotal.toFixed(2),
                isRacikan: item.isRacikan || false,
                racikanName: item.racikanName,
                signa: item.signa,
              })
              .returning();
            createdItems.push(createdItem);

            // Stock calculation
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
            const totalStockAfter = allBatches.reduce((s, b) => s + (b.stock || 0), 0);

            // Log mutation
            await tx.insert(stockMutations).values({
              tenantId,
              outletId: validated.outletId,
              productId: item.productId,
              batchId: batch.id,
              type: 'SALE',
              referenceType: 'POS_TRANSACTION',
              referenceNumber: invoiceCode,
              qtyIn: 0,
              qtyOut: deductFromThis,
              balanceAfter: totalStockAfter,
              notes: `Penjualan Kasir FEFO #${invoiceCode} (Batch: ${batch.batchNumber})`,
              createdBy: user.id,
            });
          }
        }
      }

      return {
        ...newTransaction,
        itemsCount: createdItems.length,
      };
    });

    // Fetch full receipt details
    const [receiptOutlet] = await db
      .select()
      .from(outlets)
      .where(and(eq(outlets.id, validated.outletId), eq(outlets.tenantId, tenantId)));

    return c.json({
      success: true,
      message: `Transaksi #${invoiceCode} berhasil disimpan`,
      data: {
        ...result,
        outlet: receiptOutlet,
        cashierName: user.fullName,
      },
    }, 201);
  } catch (error: any) {
    if (error instanceof TenantSecurityError) {
      return c.json({ success: false, message: error.message }, error.statusCode as any);
    }
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    console.error('Error creating transaction:', error);
    return c.json({ success: false, message: error.message || 'Gagal memproses transaksi kasir' }, 400);
  }
});


// =========================================================================
// 3. LIST TRANSACTIONS & SUMMARY
// =========================================================================

// TODAY SUMMARY METRICS
router.get('/today-summary', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const outletId = query.outletId?.trim();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const conditions = [
      eq(transactions.tenantId, tenantId),
      gte(transactions.createdAt, today),
    ];

    if (outletId) conditions.push(eq(transactions.outletId, outletId));

    const todayTrx = await db
      .select({
        grandTotal: transactions.grandTotal,
        paymentMethod: transactions.paymentMethod,
        isPrescription: transactions.isPrescription,
      })
      .from(transactions)
      .where(and(...conditions));

    let totalRevenue = 0;
    let totalCash = 0;
    let totalNonCash = 0;
    let prescriptionCount = 0;

    for (const t of todayTrx) {
      const val = Number(t.grandTotal || 0);
      totalRevenue += val;
      if (t.paymentMethod === 'cash') {
        totalCash += val;
      } else {
        totalNonCash += val;
      }
      if (t.isPrescription) {
        prescriptionCount++;
      }
    }

    return c.json({
      success: true,
      data: {
        totalRevenue,
        totalTransactions: todayTrx.length,
        totalCash,
        totalNonCash,
        prescriptionCount,
      },
    });
  } catch (error: any) {
    console.error('Error fetching today summary:', error);
    return c.json({ success: false, message: 'Gagal memuat ringkasan penjualan', error: error.message }, 500);
  }
});

// LIST TRANSACTIONS HISTORY
router.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const search = query.search?.trim();
    const outletId = query.outletId?.trim();
    const paymentMethod = query.paymentMethod?.trim();
    const isPrescription = query.isPrescription?.trim();
    const startDate = query.startDate?.trim();
    const endDate = query.endDate?.trim();
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [eq(transactions.tenantId, tenantId)];

    if (outletId) conditions.push(eq(transactions.outletId, outletId));
    if (paymentMethod && paymentMethod !== 'ALL') {
      conditions.push(eq(transactions.paymentMethod, paymentMethod));
    }
    if (isPrescription !== undefined && isPrescription !== '' && isPrescription !== 'ALL') {
      conditions.push(eq(transactions.isPrescription, isPrescription === 'true'));
    }
    if (startDate) {
      conditions.push(gte(transactions.createdAt, new Date(`${startDate}T00:00:00`)));
    }
    if (endDate) {
      conditions.push(lte(transactions.createdAt, new Date(`${endDate}T23:59:59`)));
    }

    if (search) {
      conditions.push(
        or(
          ilike(transactions.invoiceCode, `%${search}%`),
          ilike(transactions.customerName, `%${search}%`),
          ilike(transactions.doctorName, `%${search}%`),
          ilike(transactions.prescriptionNumber, `%${search}%`)
        )!
      );
    }

    const whereClause = and(...conditions);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(whereClause);

    const total = countResult?.count || 0;

    const rows = await db
      .select({
        id: transactions.id,
        invoiceCode: transactions.invoiceCode,
        customerName: transactions.customerName,
        customerPhone: transactions.customerPhone,
        doctorName: transactions.doctorName,
        prescriptionNumber: transactions.prescriptionNumber,
        isPrescription: transactions.isPrescription,
        tuslahFee: transactions.tuslahFee,
        totalSubtotal: transactions.totalSubtotal,
        discountAmount: transactions.discountAmount,
        taxAmount: transactions.taxAmount,
        grandTotal: transactions.grandTotal,
        paidAmount: transactions.paidAmount,
        changeAmount: transactions.changeAmount,
        paymentMethod: transactions.paymentMethod,
        paymentStatus: transactions.paymentStatus,
        outletId: transactions.outletId,
        outletName: outlets.name,
        outletAddress: outlets.address,
        outletPhone: outlets.phone,
        outletSia: outlets.siaNumber,
        outletSipa: outlets.sipaNumber,
        cashierId: transactions.cashierId,
        cashierName: users.fullName,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .innerJoin(outlets, eq(transactions.outletId, outlets.id))
      .innerJoin(users, eq(transactions.cashierId, users.id))
      .where(whereClause)
      .orderBy(desc(transactions.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      success: true,
      data: rows,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('Error fetching transactions:', error);
    return c.json({ success: false, message: 'Gagal memuat riwayat transaksi', error: error.message }, 500);
  }
});

// GET TRANSACTION DETAIL WITH ITEMS (RECEIPT DATA)
router.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const trxId = c.req.param('id');

    const [trx] = await db
      .select({
        id: transactions.id,
        invoiceCode: transactions.invoiceCode,
        customerName: transactions.customerName,
        customerPhone: transactions.customerPhone,
        doctorName: transactions.doctorName,
        prescriptionNumber: transactions.prescriptionNumber,
        isPrescription: transactions.isPrescription,
        tuslahFee: transactions.tuslahFee,
        totalSubtotal: transactions.totalSubtotal,
        discountAmount: transactions.discountAmount,
        taxAmount: transactions.taxAmount,
        grandTotal: transactions.grandTotal,
        paidAmount: transactions.paidAmount,
        changeAmount: transactions.changeAmount,
        paymentMethod: transactions.paymentMethod,
        paymentStatus: transactions.paymentStatus,
        notes: transactions.notes,
        outletId: transactions.outletId,
        outletName: outlets.name,
        outletAddress: outlets.address,
        outletPhone: outlets.phone,
        outletSia: outlets.siaNumber,
        outletSipa: outlets.sipaNumber,
        cashierId: transactions.cashierId,
        cashierName: users.fullName,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .innerJoin(outlets, eq(transactions.outletId, outlets.id))
      .innerJoin(users, eq(transactions.cashierId, users.id))
      .where(and(eq(transactions.id, trxId), eq(transactions.tenantId, tenantId)));

    if (!trx) {
      return c.json({ success: false, message: 'Transaksi tidak ditemukan' }, 404);
    }

    const items = await db
      .select({
        id: transactionItems.id,
        productId: transactionItems.productId,
        productName: products.name,
        productSku: products.sku,
        batchId: transactionItems.batchId,
        batchNumber: productBatches.batchNumber,
        expiredDate: productBatches.expiredDate,
        unitId: transactionItems.unitId,
        unitName: productUnits.unitName,
        quantity: transactionItems.quantity,
        baseQuantityDeducted: transactionItems.baseQuantityDeducted,
        unitPrice: transactionItems.unitPrice,
        discountPerItem: transactionItems.discountPerItem,
        subtotal: transactionItems.subtotal,
        isRacikan: transactionItems.isRacikan,
        racikanName: transactionItems.racikanName,
        signa: transactionItems.signa,
      })
      .from(transactionItems)
      .innerJoin(products, eq(transactionItems.productId, products.id))
      .innerJoin(productBatches, eq(transactionItems.batchId, productBatches.id))
      .innerJoin(productUnits, eq(transactionItems.unitId, productUnits.id))
      .where(eq(transactionItems.transactionId, trxId));

    return c.json({
      success: true,
      data: {
        ...trx,
        items,
      },
    });
  } catch (error: any) {
    console.error('Error fetching transaction detail:', error);
    return c.json({ success: false, message: 'Gagal memuat detail transaksi', error: error.message }, 500);
  }
});

export default router;
