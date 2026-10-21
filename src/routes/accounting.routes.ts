import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { db } from '../db/index';
import {
  transactions,
  transactionItems,
  productUnits,
  products,
  expenses,
  purchasePayments,
  purchaseInvoices,
  suppliers,
} from '../db/schema/index';
import { eq, and, gte, lte, desc, asc, sql } from 'drizzle-orm';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware, requireRole(['owner', 'super_admin']));

// Strict ISO Date Query Validator (YYYY-MM-DD)
const dateRangeQuerySchema = z.object({
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

// 1. LAPORAN LABA RUGI (PROFIT & LOSS / INCOME STATEMENT)
router.get('/profit-and-loss', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsedQuery = dateRangeQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return c.json({ error: 'Validasi Gagal', details: parsedQuery.error.format() }, 400);
    }
    const { startDate, endDate, outletId } = parsedQuery.data;

    // 1. REVENUE (PENJUALAN)
    const trxConditions = [
      eq(transactions.tenantId, tenantId),
      eq(transactions.paymentStatus, 'PAID'),
    ];
    if (outletId) trxConditions.push(eq(transactions.outletId, outletId));
    if (startDate) trxConditions.push(gte(sql`DATE(${transactions.createdAt})`, startDate));
    if (endDate) trxConditions.push(lte(sql`DATE(${transactions.createdAt})`, endDate));

    const [salesSummary] = await db
      .select({
        totalTransactions: sql<number>`count(*)::int`,
        grossSales: sql<number>`coalesce(sum(${transactions.totalSubtotal}), 0)::numeric`,
        totalDiscount: sql<number>`coalesce(sum(${transactions.discountAmount}), 0)::numeric`,
        netSales: sql<number>`coalesce(sum(${transactions.grandTotal}), 0)::numeric`,
      })
      .from(transactions)
      .where(and(...trxConditions));

    const grossSales = Number(salesSummary?.grossSales || 0);
    const totalDiscount = Number(salesSummary?.totalDiscount || 0);
    const netSales = Number(salesSummary?.netSales || 0);
    const totalTransactions = salesSummary?.totalTransactions || 0;

    // 2. COGS / HPP (HARGA POKOK PENJUALAN)
    // Estimate HPP from transaction items joined with base buy price or item subtotal / 1.25 margin if not set
    const itemConditions = [
      eq(transactions.tenantId, tenantId),
      eq(transactions.paymentStatus, 'PAID'),
    ];
    if (outletId) itemConditions.push(eq(transactions.outletId, outletId));
    if (startDate) itemConditions.push(gte(sql`DATE(${transactions.createdAt})`, startDate));
    if (endDate) itemConditions.push(lte(sql`DATE(${transactions.createdAt})`, endDate));

    const items = await db
      .select({
        quantity: transactionItems.quantity,
        subtotal: transactionItems.subtotal,
        unitBuyPrice: productUnits.buyPrice,
        unitSellPrice: productUnits.sellPrice,
      })
      .from(transactionItems)
      .innerJoin(transactions, eq(transactionItems.transactionId, transactions.id))
      .leftJoin(productUnits, eq(transactionItems.unitId, productUnits.id))
      .where(and(...itemConditions));

    let totalCogs = 0;
    for (const item of items) {
      const qty = Number(item.quantity) || 1;
      const buyPrice = Number(item.unitBuyPrice) || 0;
      if (buyPrice > 0) {
        totalCogs += qty * buyPrice;
      } else {
        // Fallback standard cost margin (75% of sell subtotal)
        totalCogs += (Number(item.subtotal) || 0) * 0.75;
      }
    }

    const grossProfit = Math.max(0, netSales - totalCogs);
    const grossMarginPercent = netSales > 0 ? ((grossProfit / netSales) * 100).toFixed(1) : '0';

    // 3. OPERATING EXPENSES (BEBAN OPERASIONAL)
    const expConditions = [eq(expenses.tenantId, tenantId)];
    if (outletId) expConditions.push(eq(expenses.outletId, outletId));
    if (startDate) expConditions.push(gte(expenses.expenseDate, startDate));
    if (endDate) expConditions.push(lte(expenses.expenseDate, endDate));

    const expenseList = await db
      .select({
        category: expenses.category,
        totalAmount: sql<number>`coalesce(sum(${expenses.amount}), 0)::numeric`,
        count: sql<number>`count(*)::int`,
      })
      .from(expenses)
      .where(and(...expConditions))
      .groupBy(expenses.category);

    const totalOperatingExpenses = expenseList.reduce((sum, e) => sum + Number(e.totalAmount), 0);
    const netProfit = grossProfit - totalOperatingExpenses;
    const netMarginPercent = netSales > 0 ? ((netProfit / netSales) * 100).toFixed(1) : '0';

    return c.json({
      success: true,
      data: {
        period: {
          startDate: startDate || 'Awal Sistem',
          endDate: endDate || 'Hari Ini',
        },
        revenue: {
          totalTransactions,
          grossSales,
          totalDiscount,
          netSales,
        },
        cogs: {
          totalCogs,
        },
        grossProfit: {
          amount: grossProfit,
          marginPercent: Number(grossMarginPercent),
        },
        operatingExpenses: {
          total: totalOperatingExpenses,
          breakdown: expenseList.map((e) => ({
            category: e.category,
            amount: Number(e.totalAmount),
            count: e.count,
            percentage:
              totalOperatingExpenses > 0
                ? Number(((Number(e.totalAmount) / totalOperatingExpenses) * 100).toFixed(1))
                : 0,
          })),
        },
        netProfit: {
          amount: netProfit,
          marginPercent: Number(netMarginPercent),
          isProfitable: netProfit >= 0,
        },
      },
    });
  } catch (error: any) {
    console.error('Error generating Profit & Loss statement:', error);
    return c.json({ success: false, message: 'Gagal menyusun Laporan Laba Rugi', error: error.message }, 500);
  }
});

// 2. ANALISIS PARETO / ABC (80-20 PRODUCT REVENUE CLASSIFICATION)
router.get('/pareto-abc', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsedQuery = dateRangeQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return c.json({ error: 'Validasi Gagal', details: parsedQuery.error.format() }, 400);
    }
    const { startDate, endDate, outletId } = parsedQuery.data;

    const conditions = [
      eq(transactions.tenantId, tenantId),
      eq(transactions.paymentStatus, 'PAID'),
    ];
    if (outletId) conditions.push(eq(transactions.outletId, outletId));
    if (startDate) conditions.push(gte(sql`DATE(${transactions.createdAt})`, startDate));
    if (endDate) conditions.push(lte(sql`DATE(${transactions.createdAt})`, endDate));

    // Aggregate revenue per product
    const productSales = await db
      .select({
        productId: products.id,
        productName: products.name,
        category: products.category,
        baseUnit: products.baseUnit,
        totalQuantitySold: sql<number>`coalesce(sum(${transactionItems.quantity}), 0)::numeric`,
        totalRevenue: sql<number>`coalesce(sum(${transactionItems.subtotal}), 0)::numeric`,
      })
      .from(transactionItems)
      .innerJoin(transactions, eq(transactionItems.transactionId, transactions.id))
      .innerJoin(products, eq(transactionItems.productId, products.id))
      .where(and(...conditions))
      .groupBy(products.id, products.name, products.category, products.baseUnit)
      .orderBy(desc(sql`sum(${transactionItems.subtotal})`));

    const totalSystemRevenue = productSales.reduce((sum, p) => sum + Number(p.totalRevenue), 0);

    let cumulativeRevenue = 0;
    const classifiedProducts = productSales.map((p, index) => {
      const revenue = Number(p.totalRevenue);
      cumulativeRevenue += revenue;
      const revenueSharePercent =
        totalSystemRevenue > 0 ? (revenue / totalSystemRevenue) * 100 : 0;
      const cumulativePercent =
        totalSystemRevenue > 0 ? (cumulativeRevenue / totalSystemRevenue) * 100 : 0;

      let abcClass: 'A' | 'B' | 'C' = 'C';
      if (cumulativePercent <= 80 || index === 0) {
        abcClass = 'A';
      } else if (cumulativePercent <= 95) {
        abcClass = 'B';
      } else {
        abcClass = 'C';
      }

      return {
        rank: index + 1,
        productId: p.productId,
        productName: p.productName,
        category: p.category,
        baseUnit: p.baseUnit,
        totalQuantitySold: Number(p.totalQuantitySold),
        totalRevenue: revenue,
        revenueSharePercent: Number(revenueSharePercent.toFixed(2)),
        cumulativePercent: Number(cumulativePercent.toFixed(2)),
        abcClass,
      };
    });

    const classA = classifiedProducts.filter((p) => p.abcClass === 'A');
    const classB = classifiedProducts.filter((p) => p.abcClass === 'B');
    const classC = classifiedProducts.filter((p) => p.abcClass === 'C');

    const classARevenue = classA.reduce((s, p) => s + p.totalRevenue, 0);
    const classBRevenue = classB.reduce((s, p) => s + p.totalRevenue, 0);
    const classCRevenue = classC.reduce((s, p) => s + p.totalRevenue, 0);

    return c.json({
      success: true,
      data: {
        totalSystemRevenue,
        totalProductsSold: classifiedProducts.length,
        summary: {
          classA: {
            count: classA.length,
            percentageOfSku: classifiedProducts.length > 0 ? Number(((classA.length / classifiedProducts.length) * 100).toFixed(1)) : 0,
            revenue: classARevenue,
            revenuePercent: totalSystemRevenue > 0 ? Number(((classARevenue / totalSystemRevenue) * 100).toFixed(1)) : 0,
            strategy: 'Obat Kunci Omset (High Value): Jangan sampai stockout, monitor stok harian & negosiasi harga terbaik ke PBF.',
          },
          classB: {
            count: classB.length,
            percentageOfSku: classifiedProducts.length > 0 ? Number(((classB.length / classifiedProducts.length) * 100).toFixed(1)) : 0,
            revenue: classBRevenue,
            revenuePercent: totalSystemRevenue > 0 ? Number(((classBRevenue / totalSystemRevenue) * 100).toFixed(1)) : 0,
            strategy: 'Obat Menengah (Moderate Value): Pertahankan buffer stock aman dengan reorder point teratur mingguan.',
          },
          classC: {
            count: classC.length,
            percentageOfSku: classifiedProducts.length > 0 ? Number(((classC.length / classifiedProducts.length) * 100).toFixed(1)) : 0,
            revenue: classCRevenue,
            revenuePercent: totalSystemRevenue > 0 ? Number(((classCRevenue / totalSystemRevenue) * 100).toFixed(1)) : 0,
            strategy: 'Obat Slow Moving (Low Value): Beli dalam jumlah minimum secukupnya, hindari over-stocking agar modal tidak tertahan.',
          },
        },
        products: classifiedProducts,
      },
    });
  } catch (error: any) {
    console.error('Error generating Pareto ABC analysis:', error);
    return c.json({ success: false, message: 'Gagal menyusun Analisis Pareto', error: error.message }, 500);
  }
});

// 3. BUKU KAS & JURNAL MUTASI KEUANGAN (GENERAL LEDGER & CASH FLOW)
router.get('/general-ledger', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsedQuery = dateRangeQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return c.json({ error: 'Validasi Gagal', details: parsedQuery.error.format() }, 400);
    }
    const { startDate, endDate, outletId } = parsedQuery.data;

    // 1. CASH INFLOW: POS TRANSACTIONS
    const trxConditions = [
      eq(transactions.tenantId, tenantId),
      eq(transactions.paymentStatus, 'PAID'),
    ];
    if (outletId) trxConditions.push(eq(transactions.outletId, outletId));
    if (startDate) trxConditions.push(gte(sql`DATE(${transactions.createdAt})`, startDate));
    if (endDate) trxConditions.push(lte(sql`DATE(${transactions.createdAt})`, endDate));

    const salesInflow = await db
      .select({
        id: transactions.id,
        date: transactions.createdAt,
        reference: transactions.invoiceCode,
        description: sql<string>`'Penjualan Kasir POS (' || ${transactions.paymentMethod} || ')'`,
        type: sql<string>`'INFLOW'`,
        category: sql<string>`'Pendapatan Penjualan'`,
        amount: transactions.grandTotal,
        paymentMethod: transactions.paymentMethod,
      })
      .from(transactions)
      .where(and(...trxConditions));

    // 2. CASH OUTFLOW: DEBT PAYMENTS TO PBF
    const pmtConditions = [eq(purchasePayments.tenantId, tenantId)];
    if (startDate) pmtConditions.push(gte(purchasePayments.paymentDate, startDate));
    if (endDate) pmtConditions.push(lte(purchasePayments.paymentDate, endDate));

    const pbfOutflow = await db
      .select({
        id: purchasePayments.id,
        date: purchasePayments.createdAt,
        reference: purchaseInvoices.invoiceNumber,
        description: sql<string>`'Pembayaran Faktur PBF (' || coalesce(${suppliers.name}, 'PBF') || ')'`,
        type: sql<string>`'OUTFLOW'`,
        category: sql<string>`'Pembayaran Hutang PBF'`,
        amount: purchasePayments.amount,
        paymentMethod: purchasePayments.paymentMethod,
      })
      .from(purchasePayments)
      .innerJoin(purchaseInvoices, eq(purchasePayments.purchaseInvoiceId, purchaseInvoices.id))
      .leftJoin(suppliers, eq(purchaseInvoices.supplierId, suppliers.id))
      .where(and(...pmtConditions));

    // 3. CASH OUTFLOW: OPERATIONAL EXPENSES
    const expConditions = [eq(expenses.tenantId, tenantId)];
    if (outletId) expConditions.push(eq(expenses.outletId, outletId));
    if (startDate) expConditions.push(gte(expenses.expenseDate, startDate));
    if (endDate) expConditions.push(lte(expenses.expenseDate, endDate));

    const expenseOutflow = await db
      .select({
        id: expenses.id,
        date: expenses.createdAt,
        reference: sql<string>`'EXP-' || substr(${expenses.id}::text, 1, 8)`,
        description: sql<string>`${expenses.category} || coalesce(' - ' || ${expenses.recipient}, '')`,
        type: sql<string>`'OUTFLOW'`,
        category: expenses.category,
        amount: expenses.amount,
        paymentMethod: expenses.paymentMethod,
      })
      .from(expenses)
      .where(and(...expConditions));

    // MERGE ALL MOVEMENTS AND SORT BY DATE ASCENDING TO CALCULATE RUNNING BALANCE
    const allEntries = [
      ...salesInflow.map((s) => ({
        ...s,
        amount: Number(s.amount),
        rawDate: new Date(s.date),
      })),
      ...pbfOutflow.map((p) => ({
        ...p,
        amount: Number(p.amount),
        rawDate: new Date(p.date),
      })),
      ...expenseOutflow.map((e) => ({
        ...e,
        amount: Number(e.amount),
        rawDate: new Date(e.date),
      })),
    ].sort((a, b) => a.rawDate.getTime() - b.rawDate.getTime());

    let runningBalance = 0;
    let totalInflow = 0;
    let totalOutflow = 0;

    const entriesWithBalance = allEntries.map((entry) => {
      if (entry.type === 'INFLOW') {
        runningBalance += entry.amount;
        totalInflow += entry.amount;
      } else {
        runningBalance -= entry.amount;
        totalOutflow += entry.amount;
      }

      return {
        id: entry.id,
        date: entry.date,
        reference: entry.reference,
        description: entry.description,
        type: entry.type,
        category: entry.category,
        amount: entry.amount,
        paymentMethod: entry.paymentMethod,
        balance: runningBalance,
      };
    });

    return c.json({
      success: true,
      data: {
        summary: {
          totalInflow,
          totalOutflow,
          netCashflow: totalInflow - totalOutflow,
          finalBalance: runningBalance,
          entryCount: entriesWithBalance.length,
        },
        entries: entriesWithBalance.reverse(), // Most recent first for UI
      },
    });
  } catch (error: any) {
    console.error('Error generating general ledger:', error);
    return c.json({ success: false, message: 'Gagal menyusun Buku Besar', error: error.message }, 500);
  }
});

export default router;
