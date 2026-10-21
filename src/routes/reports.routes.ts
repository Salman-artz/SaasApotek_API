import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { db } from '../db/index';
import {
  transactions,
  transactionItems,
  purchaseInvoices,
  purchaseItems,
  purchasePayments,
  products,
  productUnits,
  productBatches,
  suppliers,
  outlets,
  users,
  stockMutations,
} from '../db/schema/index';
import { eq, and, or, ilike, sql, desc, asc, gte, lte } from 'drizzle-orm';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware, requireRole(['owner', 'super_admin', 'pharmacist']));

// Strict ISO Date Query Validator (YYYY-MM-DD)
const reportQuerySchema = z.object({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal startDate harus YYYY-MM-DD')
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal endDate harus YYYY-MM-DD')
    .optional(),
  outletId: z.string().optional(),
});

// =========================================================================
// 1. LAPORAN PENJUALAN & OMZET (SALES SUMMARY & REVENUE)
// =========================================================================
router.get('/sales-summary', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsedQuery = reportQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return c.json({ error: 'Validasi Gagal', details: parsedQuery.error.format() }, 400);
    }
    const { startDate, endDate, outletId } = parsedQuery.data;

    const conditions = [eq(transactions.tenantId, tenantId)];
    if (outletId) conditions.push(eq(transactions.outletId, outletId));
    if (startDate) conditions.push(gte(transactions.createdAt, new Date(`${startDate}T00:00:00`)));
    if (endDate) conditions.push(lte(transactions.createdAt, new Date(`${endDate}T23:59:59`)));

    const allTrx = await db
      .select({
        id: transactions.id,
        invoiceCode: transactions.invoiceCode,
        grandTotal: transactions.grandTotal,
        totalSubtotal: transactions.totalSubtotal,
        discountAmount: transactions.discountAmount,
        taxAmount: transactions.taxAmount,
        tuslahFee: transactions.tuslahFee,
        paymentMethod: transactions.paymentMethod,
        isPrescription: transactions.isPrescription,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .where(and(...conditions))
      .orderBy(asc(transactions.createdAt));

    let totalRevenue = 0;
    let totalDiscount = 0;
    let totalTax = 0;
    let totalTuslah = 0;
    let cashRevenue = 0;
    let qrisRevenue = 0;
    let transferRevenue = 0;
    let debitRevenue = 0;
    let prescriptionCount = 0;
    let nonPrescriptionCount = 0;

    // Daily trend aggregation
    const dailyMap: Record<string, { date: string; revenue: number; transactions: number }> = {};

    for (const t of allTrx) {
      const gTot = Number(t.grandTotal || 0);
      const disc = Number(t.discountAmount || 0);
      const tax = Number(t.taxAmount || 0);
      const tuslah = Number(t.tuslahFee || 0);

      totalRevenue += gTot;
      totalDiscount += disc;
      totalTax += tax;
      totalTuslah += tuslah;

      if (t.paymentMethod === 'cash') cashRevenue += gTot;
      else if (t.paymentMethod === 'qris') qrisRevenue += gTot;
      else if (t.paymentMethod === 'transfer') transferRevenue += gTot;
      else if (t.paymentMethod === 'debit') debitRevenue += gTot;

      if (t.isPrescription) prescriptionCount++;
      else nonPrescriptionCount++;

      // Date group
      const dStr = new Date(t.createdAt).toISOString().slice(0, 10);
      if (!dailyMap[dStr]) {
        dailyMap[dStr] = { date: dStr, revenue: 0, transactions: 0 };
      }
      dailyMap[dStr].revenue += gTot;
      dailyMap[dStr].transactions += 1;
    }

    const totalCount = allTrx.length;
    const averageOrderValue = totalCount > 0 ? totalRevenue / totalCount : 0;
    const dailyTrend = Object.values(dailyMap);

    return c.json({
      success: true,
      data: {
        totalRevenue,
        totalTransactions: totalCount,
        averageOrderValue,
        totalDiscount,
        totalTax,
        totalTuslah,
        paymentBreakdown: {
          cash: cashRevenue,
          qris: qrisRevenue,
          transfer: transferRevenue,
          debit: debitRevenue,
        },
        prescriptionSummary: {
          prescriptionCount,
          nonPrescriptionCount,
        },
        dailyTrend,
      },
    });
  } catch (error: any) {
    console.error('Error calculating sales summary report:', error);
    return c.json({ success: false, message: 'Gagal memuat laporan penjualan', error: error.message }, 500);
  }
});


// =========================================================================
// 2. LAPORAN LABA KOTOR & MARGIN (GROSS PROFIT & MARGIN ANALYSIS)
// =========================================================================
router.get('/profit-margins', requireRole(['owner', 'super_admin']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsedQuery = reportQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return c.json({ error: 'Validasi Gagal', details: parsedQuery.error.format() }, 400);
    }
    const { startDate, endDate, outletId } = parsedQuery.data;

    const conditions = [eq(transactions.tenantId, tenantId)];
    if (outletId) conditions.push(eq(transactions.outletId, outletId));
    if (startDate) conditions.push(gte(transactions.createdAt, new Date(`${startDate}T00:00:00`)));
    if (endDate) conditions.push(lte(transactions.createdAt, new Date(`${endDate}T23:59:59`)));

    // Join transaction_items, products, batches, transactions
    const items = await db
      .select({
        id: transactionItems.id,
        productId: transactionItems.productId,
        productName: products.name,
        category: products.category,
        baseUnit: products.baseUnit,
        unitName: productUnits.unitName,
        quantity: transactionItems.quantity,
        baseQuantityDeducted: transactionItems.baseQuantityDeducted,
        unitPrice: transactionItems.unitPrice,
        discountPerItem: transactionItems.discountPerItem,
        subtotal: transactionItems.subtotal,
        costPerBaseUnit: productBatches.costPerBaseUnit,
        createdAt: transactions.createdAt,
      })
      .from(transactionItems)
      .innerJoin(transactions, eq(transactionItems.transactionId, transactions.id))
      .innerJoin(products, eq(transactionItems.productId, products.id))
      .innerJoin(productBatches, eq(transactionItems.batchId, productBatches.id))
      .innerJoin(productUnits, eq(transactionItems.unitId, productUnits.id))
      .where(and(...conditions));

    // Aggregate by product
    const productStats: Record<
      string,
      {
        productId: string;
        productName: string;
        category: string;
        baseUnit: string;
        qtySold: number;
        totalRevenue: number;
        totalHpp: number;
        grossProfit: number;
        marginPercentage: number;
      }
    > = {};

    let grandRevenue = 0;
    let grandHpp = 0;

    for (const it of items) {
      const rev = Number(it.subtotal || 0);
      const baseQty = Number(it.baseQuantityDeducted || 1);
      const hppUnit = Number(it.costPerBaseUnit || 0);
      const hppTotal = baseQty * hppUnit;

      grandRevenue += rev;
      grandHpp += hppTotal;

      if (!productStats[it.productId]) {
        productStats[it.productId] = {
          productId: it.productId,
          productName: it.productName,
          category: it.category,
          baseUnit: it.baseUnit,
          qtySold: 0,
          totalRevenue: 0,
          totalHpp: 0,
          grossProfit: 0,
          marginPercentage: 0,
        };
      }

      productStats[it.productId].qtySold += Number(it.quantity || 0);
      productStats[it.productId].totalRevenue += rev;
      productStats[it.productId].totalHpp += hppTotal;
    }

    const grandGrossProfit = grandRevenue - grandHpp;
    const grandMarginPercentage = grandRevenue > 0 ? (grandGrossProfit / grandRevenue) * 100 : 0;

    // Calculate individual product margins
    const list = Object.values(productStats).map((p) => {
      const profit = p.totalRevenue - p.totalHpp;
      const margin = p.totalRevenue > 0 ? (profit / p.totalRevenue) * 100 : 0;
      return {
        ...p,
        grossProfit: profit,
        marginPercentage: Math.round(margin * 10) / 10,
      };
    });

    // Sort by most gross profit
    list.sort((a, b) => b.grossProfit - a.grossProfit);

    return c.json({
      success: true,
      data: {
        summary: {
          totalRevenue: grandRevenue,
          totalHpp: grandHpp,
          grossProfit: grandGrossProfit,
          marginPercentage: Math.round(grandMarginPercentage * 10) / 10,
        },
        products: list,
      },
    });
  } catch (error: any) {
    console.error('Error calculating profit margin report:', error);
    return c.json({ success: false, message: 'Gagal memuat laporan laba & margin', error: error.message }, 500);
  }
});


// =========================================================================
// 3. LAPORAN OBAT TERLARIS (FAST-MOVING VS SLOW-MOVING)
// =========================================================================
router.get('/drug-movement', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsedQuery = reportQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return c.json({ error: 'Validasi Gagal', details: parsedQuery.error.format() }, 400);
    }
    const { startDate, endDate, outletId } = parsedQuery.data;

    const conditions = [eq(transactions.tenantId, tenantId)];
    if (outletId) conditions.push(eq(transactions.outletId, outletId));
    if (startDate) conditions.push(gte(transactions.createdAt, new Date(`${startDate}T00:00:00`)));
    if (endDate) conditions.push(lte(transactions.createdAt, new Date(`${endDate}T23:59:59`)));

    // Fetch all sales items
    const soldItems = await db
      .select({
        productId: transactionItems.productId,
        productName: products.name,
        category: products.category,
        baseUnit: products.baseUnit,
        quantity: transactionItems.quantity,
        subtotal: transactionItems.subtotal,
      })
      .from(transactionItems)
      .innerJoin(transactions, eq(transactionItems.transactionId, transactions.id))
      .innerJoin(products, eq(transactionItems.productId, products.id))
      .where(and(...conditions));

    // Aggregate sold counts
    const map: Record<string, { productId: string; productName: string; category: string; baseUnit: string; totalQty: number; totalRevenue: number; transactionCount: number }> = {};

    for (const item of soldItems) {
      if (!map[item.productId]) {
        map[item.productId] = {
          productId: item.productId,
          productName: item.productName,
          category: item.category,
          baseUnit: item.baseUnit,
          totalQty: 0,
          totalRevenue: 0,
          transactionCount: 0,
        };
      }
      map[item.productId].totalQty += Number(item.quantity || 0);
      map[item.productId].totalRevenue += Number(item.subtotal || 0);
      map[item.productId].transactionCount += 1;
    }

    // Also get current stock for all active products
    const allProducts = await db
      .select({
        id: products.id,
        name: products.name,
        category: products.category,
        baseUnit: products.baseUnit,
        minStockAlert: products.minStockAlert,
      })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.isActive, true)));

    const result = allProducts.map((p) => {
      const sold = map[p.id] || { totalQty: 0, totalRevenue: 0, transactionCount: 0 };
      return {
        productId: p.id,
        productName: p.name,
        category: p.category,
        baseUnit: p.baseUnit,
        totalQtySold: sold.totalQty,
        totalRevenue: sold.totalRevenue,
        transactionCount: sold.transactionCount,
        isFastMoving: sold.totalQty >= 10,
      };
    });

    // Fast moving (descending qty)
    const fastMoving = [...result].sort((a, b) => b.totalQtySold - a.totalQtySold).slice(0, 15);
    // Slow moving (ascending qty)
    const slowMoving = [...result].sort((a, b) => a.totalQtySold - b.totalQtySold).slice(0, 15);

    return c.json({
      success: true,
      data: {
        fastMoving,
        slowMoving,
        all: result,
      },
    });
  } catch (error: any) {
    console.error('Error generating drug movement report:', error);
    return c.json({ success: false, message: 'Gagal memuat analisis pergerakan obat', error: error.message }, 500);
  }
});


// =========================================================================
// 4. LAPORAN REGULASI RESMI SIPNAP KEMENKES RI (NARKOTIKA & PSIKOTROPIKA)
// =========================================================================
router.get('/sipnap', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const outletId = query.outletId?.trim();
    const category = query.category?.trim() || 'Narkotika'; // 'Narkotika' | 'Psikotropika' | 'ALL'
    const month = query.month ? parseInt(query.month, 10) : new Date().getMonth() + 1;
    const year = query.year ? parseInt(query.year, 10) : new Date().getFullYear();

    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59);

    // 1. Fetch targeted products (Narkotika / Psikotropika)
    const productConditions = [
      eq(products.tenantId, tenantId),
      eq(products.isActive, true),
    ];

    if (category === 'Narkotika') {
      productConditions.push(eq(products.category, 'Narkotika'));
    } else if (category === 'Psikotropika') {
      productConditions.push(eq(products.category, 'Psikotropika'));
    } else {
      productConditions.push(
        or(
          eq(products.category, 'Narkotika'),
          eq(products.category, 'Psikotropika')
        )!
      );
    }

    const controlledProducts = await db
      .select({
        id: products.id,
        name: products.name,
        genericName: products.genericName,
        category: products.category,
        baseUnit: products.baseUnit,
      })
      .from(products)
      .where(and(...productConditions));

    // 2. For each product, calculate Opening Balance, Incoming (Purchases), Outgoing (Prescriptions), and Closing Balance
    const sipnapRows = [];

    for (const prod of controlledProducts) {
      // Mutations during the month
      const mutationConditions = [
        eq(stockMutations.tenantId, tenantId),
        eq(stockMutations.productId, prod.id),
        gte(stockMutations.createdAt, startOfMonth),
        lte(stockMutations.createdAt, endOfMonth),
      ];
      if (outletId) mutationConditions.push(eq(stockMutations.outletId, outletId));

      const monthlyMutations = await db
        .select()
        .from(stockMutations)
        .where(and(...mutationConditions))
        .orderBy(asc(stockMutations.createdAt));

      let totalQtyIn = 0;
      let totalQtyOut = 0;

      // Collect transaction details for SIPNAP detail log (Dokter & Pasien)
      const outgoingDetails = [];
      const incomingDetails = [];

      for (const m of monthlyMutations) {
        if (m.qtyIn > 0) {
          totalQtyIn += m.qtyIn;
          incomingDetails.push({
            date: m.createdAt,
            referenceNumber: m.referenceNumber,
            qty: m.qtyIn,
            notes: m.notes,
          });
        }
        if (m.qtyOut > 0) {
          totalQtyOut += m.qtyOut;
          outgoingDetails.push({
            date: m.createdAt,
            referenceNumber: m.referenceNumber,
            qty: m.qtyOut,
            notes: m.notes,
          });
        }
      }

      // Current total stock
      const batchConditions = [
        eq(productBatches.tenantId, tenantId),
        eq(productBatches.productId, prod.id),
      ];
      if (outletId) batchConditions.push(eq(productBatches.outletId, outletId));

      const currentBatches = await db
        .select({ stock: productBatches.stockInBaseUnit })
        .from(productBatches)
        .where(and(...batchConditions));

      const closingStock = currentBatches.reduce((sum, b) => sum + (b.stock || 0), 0);
      const openingStock = Math.max(0, closingStock - totalQtyIn + totalQtyOut);

      sipnapRows.push({
        productId: prod.id,
        productName: prod.name,
        genericName: prod.genericName,
        category: prod.category,
        baseUnit: prod.baseUnit,
        openingStock,
        totalIncoming: totalQtyIn,
        totalOutgoing: totalQtyOut,
        closingStock,
        incomingDetails,
        outgoingDetails,
      });
    }

    return c.json({
      success: true,
      data: {
        period: {
          month,
          year,
          category,
          monthName: new Date(year, month - 1, 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }),
        },
        items: sipnapRows,
      },
    });
  } catch (error: any) {
    console.error('Error generating SIPNAP report:', error);
    return c.json({ success: false, message: 'Gagal menyusun laporan regulasi SIPNAP', error: error.message }, 500);
  }
});

export default router;
