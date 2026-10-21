import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { db } from '../db/index';
import { expenses, users } from '../db/schema/index';
import { eq, and, gte, lte, desc, sql, ilike } from 'drizzle-orm';
import { assertOutletBelongsToTenant, TenantSecurityError } from '../lib/tenant-validator';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

const EXPENSE_CATEGORIES = [
  'Gaji & Tunjangan Karyawan',
  'Sewa Tempat / Bangunan',
  'Listrik, Air & Internet',
  'ATK, Kantong Plastik & Struk POS',
  'Pajak, Retribusi & Izin Legalitas',
  'Pemeliharaan, Service & Kebersihan',
  'Konsumsi, Snack & Jamuan',
  'Beban Pemasaran & Promosi',
  'Lain-lain / Biaya Tak Terduga',
];

// 1. GET EXPENSE CATEGORIES
router.get('/categories', (c) => {
  return c.json({ success: true, data: EXPENSE_CATEGORIES });
});

// 2. LIST EXPENSES WITH FILTERS & SUMMARY TOTAL
router.get('/', requireRole(['owner', 'super_admin', 'pharmacist']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const search = query.search?.trim();
    const category = query.category?.trim();
    const startDate = query.startDate?.trim();
    const endDate = query.endDate?.trim();
    const outletId = query.outletId?.trim();
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [eq(expenses.tenantId, tenantId)];

    if (outletId) {
      conditions.push(eq(expenses.outletId, outletId));
    }
    if (category && category !== 'ALL') {
      conditions.push(eq(expenses.category, category));
    }
    if (startDate) {
      conditions.push(gte(expenses.expenseDate, startDate));
    }
    if (endDate) {
      conditions.push(lte(expenses.expenseDate, endDate));
    }
    if (search) {
      conditions.push(
        sql`(${expenses.recipient} ILIKE ${'%' + search + '%'} OR ${expenses.notes} ILIKE ${'%' + search + '%'})`
      );
    }

    const whereClause = and(...conditions);

    // Total count & aggregate sum
    const [summary] = await db
      .select({
        count: sql<number>`count(*)::int`,
        totalAmount: sql<number>`coalesce(sum(${expenses.amount}), 0)::numeric`,
      })
      .from(expenses)
      .where(whereClause);

    const total = summary?.count || 0;
    const totalAmount = Number(summary?.totalAmount || 0);

    const rows = await db
      .select({
        id: expenses.id,
        category: expenses.category,
        expenseDate: expenses.expenseDate,
        amount: expenses.amount,
        paymentMethod: expenses.paymentMethod,
        recipient: expenses.recipient,
        notes: expenses.notes,
        receiptUrl: expenses.receiptUrl,
        createdAt: expenses.createdAt,
        createdBy: users.fullName,
      })
      .from(expenses)
      .leftJoin(users, eq(expenses.createdById, users.id))
      .where(whereClause)
      .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      success: true,
      data: rows,
      meta: {
        total,
        totalAmount,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('Error fetching expenses:', error);
    return c.json({ success: false, message: 'Gagal mengambil data pengeluaran', error: error.message }, 500);
  }
});

// 3. CREATE EXPENSE
const expenseSchema = z.object({
  category: z.string().min(1, 'Kategori pengeluaran wajib diisi'),
  amount: z.number().min(1, 'Nominal pengeluaran harus lebih dari 0'),
  expenseDate: z.string().optional(),
  paymentMethod: z.string().default('CASH'),
  recipient: z.string().optional(),
  notes: z.string().optional(),
  receiptUrl: z.string().optional(),
  outletId: z.string().optional(),
});

router.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const body = await c.req.json();
    const validated = expenseSchema.parse(body);

    // Cross-Tenant IDOR Protection
    if (validated.outletId) {
      await assertOutletBelongsToTenant(db, validated.outletId, tenantId);
    }

    const [newExpense] = await db
      .insert(expenses)
      .values({
        tenantId,
        outletId: validated.outletId || user.outletId || null,
        category: validated.category,
        amount: validated.amount.toString(),
        expenseDate: validated.expenseDate || new Date().toISOString().split('T')[0],
        paymentMethod: validated.paymentMethod,
        recipient: validated.recipient,
        notes: validated.notes,
        receiptUrl: validated.receiptUrl,
        createdById: user.id,
      })
      .returning();

    return c.json({
      success: true,
      message: 'Pengeluaran operasional berhasil dicatat',
      data: newExpense,
    }, 201);
  } catch (error: any) {
    if (error instanceof TenantSecurityError) {
      return c.json({ success: false, message: error.message }, error.statusCode as any);
    }
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    console.error('Error creating expense:', error);
    return c.json({ success: false, message: 'Gagal mencatat pengeluaran', error: error.message }, 500);
  }
});

// 4. UPDATE EXPENSE
router.put('/:id', requireRole(['owner', 'super_admin']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json();
    const validated = expenseSchema.parse(body);

    const [updated] = await db
      .update(expenses)
      .set({
        category: validated.category,
        amount: validated.amount.toString(),
        expenseDate: validated.expenseDate,
        paymentMethod: validated.paymentMethod,
        recipient: validated.recipient,
        notes: validated.notes,
        receiptUrl: validated.receiptUrl,
        updatedAt: new Date(),
      })
      .where(and(eq(expenses.id, id), eq(expenses.tenantId, tenantId)))
      .returning();

    if (!updated) {
      return c.json({ success: false, message: 'Data pengeluaran tidak ditemukan' }, 404);
    }

    return c.json({
      success: true,
      message: 'Data pengeluaran berhasil diperbarui',
      data: updated,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    return c.json({ success: false, message: 'Gagal memperbarui pengeluaran', error: error.message }, 500);
  }
});

// 5. DELETE EXPENSE
router.delete('/:id', requireRole(['owner', 'super_admin']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');

    const [deleted] = await db
      .delete(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.tenantId, tenantId)))
      .returning();

    if (!deleted) {
      return c.json({ success: false, message: 'Data pengeluaran tidak ditemukan' }, 404);
    }

    return c.json({ success: true, message: 'Data pengeluaran berhasil dihapus' });
  } catch (error: any) {
    return c.json({ success: false, message: 'Gagal menghapus pengeluaran', error: error.message }, 500);
  }
});

export default router;
