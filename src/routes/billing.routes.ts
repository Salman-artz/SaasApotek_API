import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { db } from '../db/index';
import { subscriptions, tenants, outlets, products, transactions } from '../db/schema/index';
import { eq, and, desc, sql, gte } from 'drizzle-orm';
import { env } from '../config/env';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

const PLANS_CATALOG = [
  {
    id: 'STARTER',
    name: 'SaaS Starter Apotek',
    price: 149000,
    maxOutlets: 1,
    maxProducts: 1000,
    maxMonthlyTrx: 2000,
    features: [
      '1 Outlet Apotek',
      'Kasir POS Pintar & Cetak Thermal',
      'Stok FEFO & Batch',
      'Faktur Pembelian PBF',
      'Laporan Dasar',
    ],
  },
  {
    id: 'PRO',
    name: 'SaaS Pro Smart Pharmacy',
    price: 299000,
    popular: true,
    maxOutlets: 3,
    maxProducts: 5000,
    maxMonthlyTrx: 10000,
    features: [
      'Hingga 3 Outlet Cabang',
      'Semua fitur Starter',
      'AI OCR Faktur PBF & Auto-Mapping',
      'Google Gemini AI Pharmacist & Interaction',
      'Analisis Pareto ABC & Laba Rugi P&L',
      'Buku Kas & Pengeluaran Beban',
      'WhatsApp Struk Digital',
    ],
  },
  {
    id: 'ENTERPRISE',
    name: 'SaaS Enterprise Healthcare',
    price: 699000,
    maxOutlets: 10,
    maxProducts: 25000,
    maxMonthlyTrx: 50000,
    features: [
      'Hingga 10 Outlet Cabang',
      'Semua fitur Pro',
      'Integrasi SatuSehat Kemenkes FHIR',
      'AI Smart Order Defecta',
      'WA Pengingat Pasien Kronis H-3',
      'Mutasi Stok Antar Cabang',
      'Priority SLA 24/7',
    ],
  },
];

// 1. GET CURRENT PLAN & QUOTA USAGE
router.get('/current-plan', async (c) => {
  try {
    const tenantId = c.get('tenantId');

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    const [latestSub] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, tenantId))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    // Count active outlets
    const [outletsCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.isActive, true)));

    // Count products
    const [productsCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.isActive, true)));

    // Count monthly transactions
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    const startOfMonthStr = startOfMonth.toISOString().split('T')[0];

    const [trxCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(
        and(
          eq(transactions.tenantId, tenantId),
          gte(sql`DATE(${transactions.createdAt})`, startOfMonthStr)
        )
      );

    const currentPlanId = latestSub?.plan || tenant?.plan || 'PRO';
    const planDetail = PLANS_CATALOG.find((p) => p.id === currentPlanId) || PLANS_CATALOG[1];

    return c.json({
      success: true,
      data: {
        plan: currentPlanId,
        status: latestSub?.status || 'ACTIVE',
        startDate: latestSub?.startDate || '2026-01-01',
        endDate: latestSub?.endDate || '2026-12-31',
        daysRemaining: 180,
        quota: {
          outlets: {
            current: outletsCount?.count || 1,
            max: latestSub?.maxOutlets || planDetail.maxOutlets,
          },
          products: {
            current: productsCount?.count || 0,
            max: latestSub?.maxProducts || planDetail.maxProducts,
          },
          monthlyTrx: {
            current: trxCount?.count || 0,
            max: latestSub?.maxMonthlyTrx || planDetail.maxMonthlyTrx,
          },
        },
        catalog: PLANS_CATALOG,
      },
    });
  } catch (error: any) {
    console.error('Error fetching subscription info:', error);
    return c.json({ success: false, message: 'Gagal memuat info langganan', error: error.message }, 500);
  }
});

// 2. UPGRADE PLAN / EXTEND SUBSCRIPTION
const upgradeSchema = z.object({
  plan: z.enum(['STARTER', 'PRO', 'ENTERPRISE']),
  billingCycle: z.enum(['MONTHLY', 'ANNUAL']).default('MONTHLY'),
});

router.post('/upgrade', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');

    // Strict RBAC: Only tenant Owner can upgrade subscription
    if (user.role !== 'owner' && user.role !== 'super_admin') {
      return c.json({
        success: false,
        error: 'Forbidden',
        message: 'Akses Ditolak: Hanya akun Pemilik (Owner) yang berwenang mengubah paket langganan.',
      }, 403);
    }

    const body = await c.req.json();
    const { plan, billingCycle } = upgradeSchema.parse(body);

    const selectedCatalog = PLANS_CATALOG.find((p) => p.id === plan);
    if (!selectedCatalog) {
      return c.json({ success: false, message: 'Paket tidak valid' }, 400);
    }

    const price = billingCycle === 'ANNUAL' ? selectedCatalog.price * 10 : selectedCatalog.price;
    const durationDays = billingCycle === 'ANNUAL' ? 365 : 30;

    const startDate = new Date();
    const endDate = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
    const invoiceNumber = `INV-SAAS-${Date.now().toString().slice(-6)}`;

    const isProd = env.NODE_ENV === 'production';
    const paymentStatus = isProd ? 'PENDING' : 'PAID';
    const subStatus = isProd ? 'TRIAL' : 'ACTIVE';

    // Create subscription record
    const [newSub] = await db
      .insert(subscriptions)
      .values({
        tenantId,
        plan,
        status: subStatus,
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        pricePerMonth: price.toString(),
        maxOutlets: selectedCatalog.maxOutlets,
        maxProducts: selectedCatalog.maxProducts,
        maxMonthlyTrx: selectedCatalog.maxMonthlyTrx,
        paymentStatus,
        invoiceNumber,
      })
      .returning();

    // In non-production/demo, simulate immediate activation; in production, await real payment gateway webhook
    if (!isProd) {
      await db.update(tenants).set({ plan, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
    }

    return c.json({
      success: true,
      message: isProd
        ? `Invoice pembayaran ${invoiceNumber} untuk paket ${selectedCatalog.name} berhasil dibuat. Silakan selesaikan pembayaran.`
        : `[Demo Mode] Selamat! Apotek Anda telah berhasil di-upgrade ke paket ${selectedCatalog.name}.`,
      data: {
        ...newSub,
        invoiceNumber,
        paymentGateway: isProd ? 'Midtrans Snap (Pending Settlement)' : 'Midtrans Simulator (Dev Only)',
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    return c.json({ success: false, message: 'Gagal upgrade langganan', error: error.message }, 500);
  }
});

// 3. INVOICES HISTORY (OWNER ONLY)
router.get('/invoices', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');

    if (user.role !== 'owner' && user.role !== 'super_admin') {
      return c.json({
        success: false,
        error: 'Forbidden',
        message: 'Akses Ditolak: Hanya Owner yang dapat melihat histori invoice dan pembayaran.',
      }, 403);
    }

    const history = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, tenantId))
      .orderBy(desc(subscriptions.createdAt));

    return c.json({ success: true, data: history });
  } catch (error: any) {
    return c.json({ success: false, message: 'Gagal memuat histori invoice', error: error.message }, 500);
  }
});

export default router;
