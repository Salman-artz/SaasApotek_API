import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { db } from '../db/index';
import {
  purchaseInvoices,
  purchaseItems,
  purchaseOrders,
  purchaseOrderItems,
  purchasePayments,
  suppliers,
  outlets,
  products,
  productUnits,
  productBatches,
  stockMutations,
  users,
} from '../db/schema/index';
import { eq, and, or, ilike, sql, desc, asc, lte, gte, lt } from 'drizzle-orm';
import {
  assertOutletBelongsToTenant,
  assertSupplierBelongsToTenant,
  assertProductsBelongToTenant,
  TenantSecurityError,
} from '../lib/tenant-validator';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

// =========================================================================
// 1. SURAT PESANAN (PURCHASE ORDERS / SP)
// =========================================================================

// LIST PURCHASE ORDERS
router.get('/orders', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const search = query.search?.trim();
    const supplierId = query.supplierId?.trim();
    const orderType = query.orderType?.trim();
    const status = query.status?.trim();
    const outletId = query.outletId?.trim();
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [eq(purchaseOrders.tenantId, tenantId)];

    if (supplierId) conditions.push(eq(purchaseOrders.supplierId, supplierId));
    if (orderType && orderType !== 'ALL') conditions.push(eq(purchaseOrders.orderType, orderType));
    if (status && status !== 'ALL') conditions.push(eq(purchaseOrders.status, status));
    if (outletId) conditions.push(eq(purchaseOrders.outletId, outletId));

    if (search) {
      conditions.push(
        or(
          ilike(purchaseOrders.orderNumber, `%${search}%`),
          ilike(suppliers.name, `%${search}%`)
        )!
      );
    }

    const whereClause = and(...conditions);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
      .where(whereClause);

    const total = countResult?.count || 0;

    const orders = await db
      .select({
        id: purchaseOrders.id,
        orderNumber: purchaseOrders.orderNumber,
        orderType: purchaseOrders.orderType,
        orderDate: purchaseOrders.orderDate,
        status: purchaseOrders.status,
        apaName: purchaseOrders.apaName,
        apaSipa: purchaseOrders.apaSipa,
        notes: purchaseOrders.notes,
        outletId: purchaseOrders.outletId,
        outletName: outlets.name,
        outletSia: outlets.siaNumber,
        outletSipa: outlets.sipaNumber,
        supplierId: purchaseOrders.supplierId,
        supplierName: suppliers.name,
        supplierPhone: suppliers.phone,
        supplierAddress: suppliers.address,
        createdAt: purchaseOrders.createdAt,
      })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
      .innerJoin(outlets, eq(purchaseOrders.outletId, outlets.id))
      .where(whereClause)
      .orderBy(desc(purchaseOrders.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      success: true,
      data: orders,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('Error fetching purchase orders:', error);
    return c.json({ success: false, message: 'Gagal mengambil daftar Surat Pesanan', error: error.message }, 500);
  }
});

// GET PURCHASE ORDER DETAIL
router.get('/orders/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const orderId = c.req.param('id');

    const [order] = await db
      .select({
        id: purchaseOrders.id,
        orderNumber: purchaseOrders.orderNumber,
        orderType: purchaseOrders.orderType,
        orderDate: purchaseOrders.orderDate,
        status: purchaseOrders.status,
        apaName: purchaseOrders.apaName,
        apaSipa: purchaseOrders.apaSipa,
        notes: purchaseOrders.notes,
        outletId: purchaseOrders.outletId,
        outletName: outlets.name,
        outletAddress: outlets.address,
        outletPhone: outlets.phone,
        outletSia: outlets.siaNumber,
        outletSipa: outlets.sipaNumber,
        supplierId: purchaseOrders.supplierId,
        supplierName: suppliers.name,
        supplierPhone: suppliers.phone,
        supplierAddress: suppliers.address,
        createdAt: purchaseOrders.createdAt,
      })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
      .innerJoin(outlets, eq(purchaseOrders.outletId, outlets.id))
      .where(and(eq(purchaseOrders.id, orderId), eq(purchaseOrders.tenantId, tenantId)));

    if (!order) {
      return c.json({ success: false, message: 'Surat Pesanan tidak ditemukan' }, 404);
    }

    const items = await db
      .select({
        id: purchaseOrderItems.id,
        productId: purchaseOrderItems.productId,
        productName: products.name,
        genericName: products.genericName,
        quantity: purchaseOrderItems.quantity,
        unitName: purchaseOrderItems.unitName,
        dosageForm: purchaseOrderItems.dosageForm,
        strength: purchaseOrderItems.strength,
        notes: purchaseOrderItems.notes,
      })
      .from(purchaseOrderItems)
      .innerJoin(products, eq(purchaseOrderItems.productId, products.id))
      .where(eq(purchaseOrderItems.purchaseOrderId, orderId));

    return c.json({
      success: true,
      data: {
        ...order,
        items,
      },
    });
  } catch (error: any) {
    console.error('Error fetching purchase order detail:', error);
    return c.json({ success: false, message: 'Gagal memuat detail Surat Pesanan', error: error.message }, 500);
  }
});

// CREATE PURCHASE ORDER (SP)
const createOrderSchema = z.object({
  outletId: z.string().uuid(),
  supplierId: z.string().uuid(),
  orderType: z.enum(['REGULAR', 'PRECURSOR', 'OOT', 'PSYCHOTROPIC', 'NARCOTIC']),
  orderDate: z.string().min(1, 'Tanggal pesanan wajib diisi'),
  apaName: z.string().optional(),
  apaSipa: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.number().int().positive('Jumlah pesanan harus > 0'),
      unitName: z.string().min(1, 'Satuan wajib diisi'),
      dosageForm: z.string().optional(),
      strength: z.string().optional(),
      notes: z.string().optional(),
    })
  ).min(1, 'Minimal 1 item pesanan obat'),
});

router.post('/orders', requireRole(['owner', 'super_admin', 'pharmacist', 'inventory']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const body = await c.req.json();
    const validated = createOrderSchema.parse(body);

    // Cross-Tenant IDOR Protection
    await assertOutletBelongsToTenant(db, validated.outletId, tenantId);
    await assertSupplierBelongsToTenant(db, validated.supplierId, tenantId);
    await assertProductsBelongToTenant(db, validated.items.map((i) => i.productId), tenantId);

    const now = new Date();
    const yyyymm = now.toISOString().slice(0, 7).replace('-', '');
    const randomSuffix = Math.floor(100 + Math.random() * 900);
    const prefixMap: Record<string, string> = {
      REGULAR: 'SP/REG',
      PRECURSOR: 'SP/PREC',
      OOT: 'SP/OOT',
      PSYCHOTROPIC: 'SP/PSI',
      NARCOTIC: 'SP/NARC',
    };
    const orderNumber = `${prefixMap[validated.orderType] || 'SP'}/${yyyymm}/${randomSuffix}`;

    const result = await db.transaction(async (tx) => {
      const [order] = await tx
        .insert(purchaseOrders)
        .values({
          tenantId,
          outletId: validated.outletId,
          supplierId: validated.supplierId,
          orderNumber,
          orderType: validated.orderType,
          orderDate: validated.orderDate,
          status: 'SENT',
          apaName: validated.apaName || user.fullName,
          apaSipa: validated.apaSipa || '',
          notes: validated.notes,
          createdBy: user.id,
        })
        .returning();

      for (const item of validated.items) {
        await tx.insert(purchaseOrderItems).values({
          purchaseOrderId: order.id,
          productId: item.productId,
          quantity: item.quantity,
          unitName: item.unitName,
          dosageForm: item.dosageForm || 'Tablet',
          strength: item.strength || '',
          notes: item.notes,
        });
      }

      return order;
    });

    return c.json({
      success: true,
      message: `Surat Pesanan ${orderNumber} berhasil dibuat`,
      data: result,
    }, 201);
  } catch (error: any) {
    if (error instanceof TenantSecurityError) {
      return c.json({ success: false, message: error.message }, error.statusCode as any);
    }
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    console.error('Error creating purchase order:', error);
    return c.json({ success: false, message: 'Gagal membuat Surat Pesanan', error: error.message }, 500);
  }
});

// UPDATE ORDER STATUS
router.patch('/orders/:id/status', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const orderId = c.req.param('id');
    const body = await c.req.json();
    const { status } = z.object({ status: z.enum(['DRAFT', 'SENT', 'RECEIVED', 'CANCELLED']) }).parse(body);

    const [updated] = await db
      .update(purchaseOrders)
      .set({ status })
      .where(and(eq(purchaseOrders.id, orderId), eq(purchaseOrders.tenantId, tenantId)))
      .returning();

    if (!updated) {
      return c.json({ success: false, message: 'Surat Pesanan tidak ditemukan' }, 404);
    }

    return c.json({ success: true, message: `Status SP diperbarui menjadi ${status}`, data: updated });
  } catch (error: any) {
    return c.json({ success: false, message: 'Gagal memperbarui status SP', error: error.message }, 400);
  }
});


// =========================================================================
// 2. FAKTUR PEMBELIAN & PENERIMAAN BARANG (PURCHASE INVOICES)
// =========================================================================

// LIST PURCHASE INVOICES
router.get('/invoices', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const search = query.search?.trim();
    const supplierId = query.supplierId?.trim();
    const outletId = query.outletId?.trim();
    const paymentStatus = query.paymentStatus?.trim();
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [eq(purchaseInvoices.tenantId, tenantId)];

    if (supplierId) conditions.push(eq(purchaseInvoices.supplierId, supplierId));
    if (outletId) conditions.push(eq(purchaseInvoices.outletId, outletId));
    if (paymentStatus && paymentStatus !== 'ALL') {
      conditions.push(eq(purchaseInvoices.paymentStatus, paymentStatus));
    }

    if (search) {
      conditions.push(
        or(
          ilike(purchaseInvoices.invoiceNumber, `%${search}%`),
          ilike(suppliers.name, `%${search}%`)
        )!
      );
    }

    const whereClause = and(...conditions);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(purchaseInvoices)
      .innerJoin(suppliers, eq(purchaseInvoices.supplierId, suppliers.id))
      .where(whereClause);

    const total = countResult?.count || 0;

    const invoices = await db
      .select({
        id: purchaseInvoices.id,
        invoiceNumber: purchaseInvoices.invoiceNumber,
        invoiceDate: purchaseInvoices.invoiceDate,
        dueDate: purchaseInvoices.dueDate,
        totalAmount: purchaseInvoices.totalAmount,
        paidAmount: purchaseInvoices.paidAmount,
        paymentStatus: purchaseInvoices.paymentStatus,
        scanInvoiceUrl: purchaseInvoices.scanInvoiceUrl,
        outletId: purchaseInvoices.outletId,
        outletName: outlets.name,
        supplierId: purchaseInvoices.supplierId,
        supplierName: suppliers.name,
        supplierPhone: suppliers.phone,
        createdAt: purchaseInvoices.createdAt,
      })
      .from(purchaseInvoices)
      .innerJoin(suppliers, eq(purchaseInvoices.supplierId, suppliers.id))
      .innerJoin(outlets, eq(purchaseInvoices.outletId, outlets.id))
      .where(whereClause)
      .orderBy(desc(purchaseInvoices.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      success: true,
      data: invoices,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('Error fetching purchase invoices:', error);
    return c.json({ success: false, message: 'Gagal memuat faktur pembelian', error: error.message }, 500);
  }
});

// GET INVOICE DETAIL WITH ITEMS & PAYMENTS
router.get('/invoices/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const invoiceId = c.req.param('id');

    const [invoice] = await db
      .select({
        id: purchaseInvoices.id,
        invoiceNumber: purchaseInvoices.invoiceNumber,
        invoiceDate: purchaseInvoices.invoiceDate,
        dueDate: purchaseInvoices.dueDate,
        totalAmount: purchaseInvoices.totalAmount,
        paidAmount: purchaseInvoices.paidAmount,
        paymentStatus: purchaseInvoices.paymentStatus,
        scanInvoiceUrl: purchaseInvoices.scanInvoiceUrl,
        outletId: purchaseInvoices.outletId,
        outletName: outlets.name,
        supplierId: purchaseInvoices.supplierId,
        supplierName: suppliers.name,
        supplierPhone: suppliers.phone,
        supplierAddress: suppliers.address,
        createdAt: purchaseInvoices.createdAt,
      })
      .from(purchaseInvoices)
      .innerJoin(suppliers, eq(purchaseInvoices.supplierId, suppliers.id))
      .innerJoin(outlets, eq(purchaseInvoices.outletId, outlets.id))
      .where(and(eq(purchaseInvoices.id, invoiceId), eq(purchaseInvoices.tenantId, tenantId)));

    if (!invoice) {
      return c.json({ success: false, message: 'Faktur tidak ditemukan' }, 404);
    }

    const items = await db
      .select({
        id: purchaseItems.id,
        productId: purchaseItems.productId,
        productName: products.name,
        productSku: products.sku,
        batchId: purchaseItems.batchId,
        batchNumber: productBatches.batchNumber,
        expiredDate: productBatches.expiredDate,
        unitId: purchaseItems.unitId,
        unitName: productUnits.unitName,
        conversionFactor: productUnits.conversionFactor,
        quantity: purchaseItems.quantity,
        pricePerUnit: purchaseItems.pricePerUnit,
        discount: purchaseItems.discount,
        subtotal: purchaseItems.subtotal,
      })
      .from(purchaseItems)
      .innerJoin(products, eq(purchaseItems.productId, products.id))
      .innerJoin(productBatches, eq(purchaseItems.batchId, productBatches.id))
      .innerJoin(productUnits, eq(purchaseItems.unitId, productUnits.id))
      .where(eq(purchaseItems.purchaseInvoiceId, invoiceId));

    const payments = await db
      .select({
        id: purchasePayments.id,
        paymentDate: purchasePayments.paymentDate,
        amount: purchasePayments.amount,
        paymentMethod: purchasePayments.paymentMethod,
        referenceNumber: purchasePayments.referenceNumber,
        notes: purchasePayments.notes,
        userName: users.fullName,
        createdAt: purchasePayments.createdAt,
      })
      .from(purchasePayments)
      .leftJoin(users, eq(purchasePayments.createdBy, users.id))
      .where(eq(purchasePayments.purchaseInvoiceId, invoiceId))
      .orderBy(desc(purchasePayments.createdAt));

    return c.json({
      success: true,
      data: {
        ...invoice,
        items,
        payments,
      },
    });
  } catch (error: any) {
    console.error('Error fetching invoice detail:', error);
    return c.json({ success: false, message: 'Gagal memuat detail faktur', error: error.message }, 500);
  }
});

// CREATE PURCHASE INVOICE & AUTO RECEIVE BATCHES (ACID TRANSACTION)
const createInvoiceSchema = z.object({
  outletId: z.string().uuid(),
  supplierId: z.string().uuid(),
  invoiceNumber: z.string().min(1, 'Nomor faktur wajib diisi'),
  invoiceDate: z.string().min(1, 'Tanggal faktur wajib diisi'),
  dueDate: z.string().optional(),
  totalAmount: z.number().positive('Total nominal faktur harus > 0'),
  paidAmount: z.number().min(0).default(0),
  scanInvoiceUrl: z.string().optional(),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      unitId: z.string().uuid(),
      quantity: z.number().int().positive('Jumlah harus > 0'),
      pricePerUnit: z.number().positive('Harga beli satuan harus > 0'),
      discount: z.number().min(0).default(0),
      subtotal: z.number().positive('Subtotal harus > 0'),
      batchNumber: z.string().min(1, 'Nomor batch wajib diisi'),
      expiredDate: z.string().min(1, 'Tanggal expired batch wajib diisi'),
    })
  ).min(1, 'Minimal 1 item obat dalam faktur'),
});

router.post('/invoices', requireRole(['owner', 'super_admin', 'pharmacist', 'inventory']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const body = await c.req.json();
    const validated = createInvoiceSchema.parse(body);

    // Cross-Tenant IDOR Protection
    await assertOutletBelongsToTenant(db, validated.outletId, tenantId);
    await assertSupplierBelongsToTenant(db, validated.supplierId, tenantId);
    await assertProductsBelongToTenant(db, validated.items.map((i) => i.productId), tenantId);

    const paymentStatus =
      validated.paidAmount >= validated.totalAmount
        ? 'paid'
        : validated.paidAmount > 0
        ? 'partial'
        : 'unpaid';

    const result = await db.transaction(async (tx) => {
      // 1. Get supplier name for notes
      const [supplier] = await tx
        .select({ name: suppliers.name })
        .from(suppliers)
        .where(and(eq(suppliers.id, validated.supplierId), eq(suppliers.tenantId, tenantId)));

      const supplierName = supplier?.name || 'PBF';

      // 2. Insert invoice header
      const [invoice] = await tx
        .insert(purchaseInvoices)
        .values({
          tenantId,
          outletId: validated.outletId,
          supplierId: validated.supplierId,
          invoiceNumber: validated.invoiceNumber,
          invoiceDate: validated.invoiceDate,
          dueDate: validated.dueDate || validated.invoiceDate,
          totalAmount: validated.totalAmount.toString(),
          paidAmount: validated.paidAmount.toString(),
          paymentStatus,
          scanInvoiceUrl: validated.scanInvoiceUrl,
        })
        .returning();

      // 3. Process each purchase item
      for (const item of validated.items) {
        // Get unit info for conversion factor
        const [unit] = await tx
          .select()
          .from(productUnits)
          .where(eq(productUnits.id, item.unitId));

        const conversionFactor = unit?.conversionFactor || 1;
        const totalBaseQty = item.quantity * conversionFactor;
        const costPerBaseUnit = (item.subtotal / totalBaseQty).toFixed(2);

        // Check if batch with same number exists
        const [existingBatch] = await tx
          .select()
          .from(productBatches)
          .where(
            and(
              eq(productBatches.tenantId, tenantId),
              eq(productBatches.outletId, validated.outletId),
              eq(productBatches.productId, item.productId),
              eq(productBatches.batchNumber, item.batchNumber)
            )
          );

        let batchId: string;

        if (existingBatch) {
          batchId = existingBatch.id;
          const newBatchStock = (existingBatch.stockInBaseUnit || 0) + totalBaseQty;
          await tx
            .update(productBatches)
            .set({
              stockInBaseUnit: newBatchStock,
              costPerBaseUnit,
              expiredDate: item.expiredDate,
            })
            .where(eq(productBatches.id, existingBatch.id));
        } else {
          const [newBatch] = await tx
            .insert(productBatches)
            .values({
              tenantId,
              outletId: validated.outletId,
              productId: item.productId,
              batchNumber: item.batchNumber,
              expiredDate: item.expiredDate,
              stockInBaseUnit: totalBaseQty,
              costPerBaseUnit,
            })
            .returning();
          batchId = newBatch.id;
        }

        // Insert purchase item
        await tx.insert(purchaseItems).values({
          purchaseInvoiceId: invoice.id,
          productId: item.productId,
          batchId,
          unitId: item.unitId,
          quantity: item.quantity,
          pricePerUnit: item.pricePerUnit.toString(),
          discount: item.discount.toString(),
          subtotal: item.subtotal.toString(),
        });

        // Calculate total stock after
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

        const totalProductStock = allBatches.reduce((sum, b) => sum + (b.stock || 0), 0);

        // Record stock mutation
        await tx.insert(stockMutations).values({
          tenantId,
          outletId: validated.outletId,
          productId: item.productId,
          batchId,
          type: 'PURCHASE',
          referenceType: 'PURCHASE_INVOICE',
          referenceNumber: validated.invoiceNumber,
          qtyIn: totalBaseQty,
          qtyOut: 0,
          balanceAfter: totalProductStock,
          notes: `Penerimaan Faktur #${validated.invoiceNumber} dari ${supplierName} (${item.quantity} ${unit?.unitName || 'Satuan'})`,
          createdBy: user.id,
        });
      }

      // If initial paidAmount > 0, record purchase payment
      if (validated.paidAmount > 0) {
        await tx.insert(purchasePayments).values({
          tenantId,
          purchaseInvoiceId: invoice.id,
          paymentDate: validated.invoiceDate,
          amount: validated.paidAmount.toString(),
          paymentMethod: 'BANK_TRANSFER',
          referenceNumber: `DP-${validated.invoiceNumber}`,
          notes: 'Pembayaran awal saat input faktur',
          createdBy: user.id,
        });
      }

      return invoice;
    });

    return c.json({
      success: true,
      message: `Faktur #${validated.invoiceNumber} berhasil disimpan dan stok batch telah diterima`,
      data: result,
    }, 201);
  } catch (error: any) {
    if (error instanceof TenantSecurityError) {
      return c.json({ success: false, message: error.message }, error.statusCode as any);
    }
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    console.error('Error creating purchase invoice:', error);
    return c.json({ success: false, message: error.message || 'Gagal menyimpan faktur pembelian' }, 500);
  }
});


// =========================================================================
// 3. MANAJEMEN HUTANG DAGANG (ACCOUNTS PAYABLE / AP & DEBT PAYMENTS)
// =========================================================================

// GET DEBT SUMMARY (AP DASHBOARD METRICS)
router.get('/debts/summary', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const outletId = query.outletId?.trim();

    const conditions = [eq(purchaseInvoices.tenantId, tenantId)];
    if (outletId) conditions.push(eq(purchaseInvoices.outletId, outletId));

    const allInvoices = await db
      .select({
        id: purchaseInvoices.id,
        totalAmount: purchaseInvoices.totalAmount,
        paidAmount: purchaseInvoices.paidAmount,
        paymentStatus: purchaseInvoices.paymentStatus,
        dueDate: purchaseInvoices.dueDate,
      })
      .from(purchaseInvoices)
      .where(and(...conditions));

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const sevenDaysLater = new Date(today);
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);

    let totalOutstanding = 0;
    let overdueCount = 0;
    let overdueAmount = 0;
    let dueThisWeekCount = 0;
    let dueThisWeekAmount = 0;
    let totalPaid = 0;

    for (const inv of allInvoices) {
      const tot = Number(inv.totalAmount || 0);
      const paid = Number(inv.paidAmount || 0);
      const remaining = Math.max(0, tot - paid);

      totalPaid += paid;

      if (remaining > 0) {
        totalOutstanding += remaining;

        if (inv.dueDate) {
          const due = new Date(inv.dueDate);
          due.setHours(0, 0, 0, 0);

          if (due < today) {
            overdueCount++;
            overdueAmount += remaining;
          } else if (due <= sevenDaysLater) {
            dueThisWeekCount++;
            dueThisWeekAmount += remaining;
          }
        }
      }
    }

    return c.json({
      success: true,
      data: {
        totalOutstanding,
        overdue: {
          count: overdueCount,
          amount: overdueAmount,
        },
        dueThisWeek: {
          count: dueThisWeekCount,
          amount: dueThisWeekAmount,
        },
        totalPaid,
        totalInvoices: allInvoices.length,
      },
    });
  } catch (error: any) {
    console.error('Error calculating debts summary:', error);
    return c.json({ success: false, message: 'Gagal memuat ringkasan hutang dagang', error: error.message }, 500);
  }
});

// PAY DEBT INVOICE (RECORD PAYMENT)
const payDebtSchema = z.object({
  paymentDate: z.string().min(1, 'Tanggal pembayaran wajib diisi'),
  amount: z.number().positive('Nominal pembayaran harus > 0'),
  paymentMethod: z.enum(['BANK_TRANSFER', 'CASH', 'GIRO']).default('BANK_TRANSFER'),
  referenceNumber: z.string().optional(),
  notes: z.string().optional(),
});

router.post('/invoices/:id/payments', requireRole(['owner', 'super_admin']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const invoiceId = c.req.param('id');
    const body = await c.req.json();
    const validated = payDebtSchema.parse(body);

    const result = await db.transaction(async (tx) => {
      // 1. Get invoice
      const [invoice] = await tx
        .select()
        .from(purchaseInvoices)
        .where(and(eq(purchaseInvoices.id, invoiceId), eq(purchaseInvoices.tenantId, tenantId)));

      if (!invoice) {
        throw new Error('Faktur pembelian tidak ditemukan');
      }

      const currentTotal = Number(invoice.totalAmount || 0);
      const currentPaid = Number(invoice.paidAmount || 0);
      const remainingDebt = currentTotal - currentPaid;

      if (validated.amount > remainingDebt + 0.01) {
        throw new Error(`Nominal pembayaran (${validated.amount}) melebihi sisa hutang (${remainingDebt})`);
      }

      const newPaidAmount = currentPaid + validated.amount;
      const newStatus = newPaidAmount >= currentTotal - 0.01 ? 'paid' : 'partial';

      // 2. Update invoice
      const [updatedInvoice] = await tx
        .update(purchaseInvoices)
        .set({
          paidAmount: newPaidAmount.toFixed(2),
          paymentStatus: newStatus,
        })
        .where(eq(purchaseInvoices.id, invoice.id))
        .returning();

      // 3. Insert payment record
      const [payment] = await tx
        .insert(purchasePayments)
        .values({
          tenantId,
          purchaseInvoiceId: invoice.id,
          paymentDate: validated.paymentDate,
          amount: validated.amount.toString(),
          paymentMethod: validated.paymentMethod,
          referenceNumber: validated.referenceNumber,
          notes: validated.notes || 'Pembayaran hutang faktur',
          createdBy: user.id,
        })
        .returning();

      return {
        invoice: updatedInvoice,
        payment,
      };
    });

    return c.json({
      success: true,
      message: 'Pembayaran hutang berhasil disimpan',
      data: result,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    console.error('Error paying invoice debt:', error);
    return c.json({ success: false, message: error.message || 'Gagal menyimpan pembayaran hutang' }, 400);
  }
});

export default router;
