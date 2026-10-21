import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { db } from '../db/index';
import { suppliers } from '../db/schema/index';
import { eq, and, ilike, or } from 'drizzle-orm';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

// LIST SUPPLIERS
router.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const search = c.req.query('search')?.trim();

    const conditions = [eq(suppliers.tenantId, tenantId), eq(suppliers.isActive, true)];

    if (search) {
      conditions.push(
        or(
          ilike(suppliers.name, `%${search}%`),
          ilike(suppliers.phone, `%${search}%`),
          ilike(suppliers.address, `%${search}%`)
        )!
      );
    }

    const rows = await db
      .select()
      .from(suppliers)
      .where(and(...conditions))
      .orderBy(suppliers.name);

    return c.json({ data: rows });
  } catch (error) {
    return c.json({ error: 'Server Error', message: 'Gagal mengambil data supplier/PBF' }, 500);
  }
});

// CREATE SUPPLIER / PBF
router.post('/', requireRole(['owner', 'super_admin', 'pharmacist', 'inventory']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();

    const schema = z.object({
      name: z.string().min(2, 'Nama PBF / Distributor minimal 2 karakter'),
      phone: z.string().optional(),
      address: z.string().optional(),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validasi Gagal', details: parsed.error.format() }, 400);
    }

    const [newSupplier] = await db
      .insert(suppliers)
      .values({
        tenantId,
        name: parsed.data.name,
        phone: parsed.data.phone || null,
        address: parsed.data.address || null,
        isActive: true,
      })
      .returning();

    return c.json({ message: 'Distributor / PBF berhasil ditambahkan', data: newSupplier }, 201);
  } catch (error) {
    return c.json({ error: 'Server Error', message: 'Gagal menambahkan supplier' }, 500);
  }
});

// UPDATE SUPPLIER
router.put('/:id', requireRole(['owner', 'super_admin', 'pharmacist', 'inventory']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json();

    const schema = z.object({
      name: z.string().min(2).optional(),
      phone: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      isActive: z.boolean().optional(),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validasi Gagal', details: parsed.error.format() }, 400);
    }

    const [updated] = await db
      .update(suppliers)
      .set(parsed.data)
      .where(and(eq(suppliers.id, id), eq(suppliers.tenantId, tenantId)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Distributor tidak ditemukan' }, 404);
    }

    return c.json({ message: 'Data PBF berhasil diperbarui', data: updated });
  } catch (error) {
    return c.json({ error: 'Server Error' }, 500);
  }
});

// DELETE SUPPLIER (SOFT DELETE)
router.delete('/:id', requireRole(['owner', 'super_admin']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');

    const [deleted] = await db
      .update(suppliers)
      .set({ isActive: false })
      .where(and(eq(suppliers.id, id), eq(suppliers.tenantId, tenantId)))
      .returning();

    if (!deleted) {
      return c.json({ error: 'Distributor tidak ditemukan' }, 404);
    }

    return c.json({ message: 'Distributor berhasil dihapus' });
  } catch (error) {
    return c.json({ error: 'Server Error' }, 500);
  }
});

export default router;
