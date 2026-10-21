import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { db } from '../db/index';
import { customers, transactions, transactionItems, products } from '../db/schema/index';
import { eq, and, or, ilike, desc, sql } from 'drizzle-orm';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

// LIST CUSTOMERS WITH SEARCH & PAGINATION
router.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const search = query.search?.trim();
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [eq(customers.tenantId, tenantId)];

    if (search) {
      conditions.push(
        or(
          ilike(customers.name, `%${search}%`),
          ilike(customers.phone, `%${search}%`),
          ilike(customers.allergies, `%${search}%`)
        )!
      );
    }

    const whereClause = and(...conditions);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(customers)
      .where(whereClause);

    const total = countResult?.count || 0;

    const rows = await db
      .select()
      .from(customers)
      .where(whereClause)
      .orderBy(desc(customers.createdAt))
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
    console.error('Error fetching customers:', error);
    return c.json({ success: false, message: 'Gagal mengambil data pasien', error: error.message }, 500);
  }
});

// GET CUSTOMER DETAIL WITH MEDICATION HISTORY (PMR - PATIENT MEDICATION RECORD)
router.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const customerId = c.req.param('id');

    const [customer] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)));

    if (!customer) {
      return c.json({ success: false, message: 'Data pasien tidak ditemukan' }, 404);
    }

    // Medication history (match by customerName or phone)
    const history = await db
      .select({
        transactionId: transactions.id,
        invoiceCode: transactions.invoiceCode,
        doctorName: transactions.doctorName,
        prescriptionNumber: transactions.prescriptionNumber,
        isPrescription: transactions.isPrescription,
        grandTotal: transactions.grandTotal,
        paymentMethod: transactions.paymentMethod,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.tenantId, tenantId),
          or(
            eq(transactions.customerName, customer.name),
            customer.phone ? eq(transactions.customerPhone, customer.phone) : undefined
          )
        )
      )
      .orderBy(desc(transactions.createdAt))
      .limit(20);

    return c.json({
      success: true,
      data: {
        ...customer,
        medicationHistory: history,
      },
    });
  } catch (error: any) {
    console.error('Error fetching customer detail:', error);
    return c.json({ success: false, message: 'Gagal memuat detail pasien', error: error.message }, 500);
  }
});

// CREATE CUSTOMER
const customerSchema = z.object({
  name: z.string().min(2, 'Nama pasien minimal 2 karakter'),
  phone: z.string().optional(),
  address: z.string().optional(),
  allergies: z.string().optional(),
  notes: z.string().optional(),
});

router.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const validated = customerSchema.parse(body);

    const [newCustomer] = await db
      .insert(customers)
      .values({
        tenantId,
        name: validated.name,
        phone: validated.phone,
        address: validated.address,
        allergies: validated.allergies,
        notes: validated.notes,
      })
      .returning();

    return c.json({
      success: true,
      message: 'Data pasien berhasil ditambahkan',
      data: newCustomer,
    }, 201);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    console.error('Error creating customer:', error);
    return c.json({ success: false, message: 'Gagal menambahkan pasien', error: error.message }, 500);
  }
});

// UPDATE CUSTOMER
router.put('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const customerId = c.req.param('id');
    const body = await c.req.json();
    const validated = customerSchema.parse(body);

    const [updated] = await db
      .update(customers)
      .set({
        name: validated.name,
        phone: validated.phone,
        address: validated.address,
        allergies: validated.allergies,
        notes: validated.notes,
      })
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)))
      .returning();

    if (!updated) {
      return c.json({ success: false, message: 'Data pasien tidak ditemukan' }, 404);
    }

    return c.json({
      success: true,
      message: 'Data pasien berhasil diperbarui',
      data: updated,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    return c.json({ success: false, message: 'Gagal memperbarui data pasien', error: error.message }, 500);
  }
});

// DELETE CUSTOMER
router.delete('/:id', requireRole(['owner', 'super_admin']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const customerId = c.req.param('id');

    const [deleted] = await db
      .delete(customers)
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)))
      .returning();

    if (!deleted) {
      return c.json({ success: false, message: 'Data pasien tidak ditemukan' }, 404);
    }

    return c.json({ success: true, message: 'Data pasien berhasil dihapus' });
  } catch (error: any) {
    return c.json({ success: false, message: 'Gagal menghapus data pasien', error: error.message }, 500);
  }
});

export default router;
