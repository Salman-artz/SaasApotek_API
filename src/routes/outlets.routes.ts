import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { db } from '../db/index';
import { outlets } from '../db/schema/index';
import { eq, and } from 'drizzle-orm';

const router = new Hono();
router.use('*', authMiddleware);

// LIST OUTLETS FOR CURRENT TENANT
router.get('/', async (c) => {
  try {
    const auth = c.get('user');
    const rows = await db
      .select()
      .from(outlets)
      .where(eq(outlets.tenantId, auth.tenantId));

    return c.json({ data: rows });
  } catch (error) {
    return c.json({ error: 'Server Error', message: 'Gagal mengambil data outlet' }, 500);
  }
});

// CREATE NEW OUTLET
router.post('/', async (c) => {
  try {
    const auth = c.get('user');
    if (auth.role !== 'owner' && auth.role !== 'super_admin') {
      return c.json({ error: 'Akses Ditolak', message: 'Hanya Owner yang dapat menambah cabang' }, 403);
    }

    const body = await c.req.json();
    const schema = z.object({
      name: z.string().min(2, 'Nama outlet minimal 2 karakter'),
      address: z.string().optional(),
      phone: z.string().optional(),
      siaNumber: z.string().optional(),
      sipaNumber: z.string().optional(),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validasi Gagal', details: parsed.error.format() }, 400);
    }

    const [newOutlet] = await db
      .insert(outlets)
      .values({
        tenantId: auth.tenantId,
        name: parsed.data.name,
        address: parsed.data.address || null,
        phone: parsed.data.phone || null,
        siaNumber: parsed.data.siaNumber || null,
        sipaNumber: parsed.data.sipaNumber || null,
        isActive: true,
      })
      .returning();

    return c.json({ message: 'Outlet berhasil ditambahkan', data: newOutlet }, 201);
  } catch (error) {
    return c.json({ error: 'Server Error', message: 'Gagal menambahkan outlet' }, 500);
  }
});

// UPDATE OUTLET
router.put('/:id', async (c) => {
  try {
    const auth = c.get('user');
    if (auth.role !== 'owner' && auth.role !== 'super_admin') {
      return c.json({ error: 'Akses Ditolak' }, 403);
    }

    const id = c.req.param('id');
    const body = await c.req.json();
    const schema = z.object({
      name: z.string().min(2).optional(),
      address: z.string().optional(),
      phone: z.string().optional(),
      siaNumber: z.string().optional(),
      sipaNumber: z.string().optional(),
      isActive: z.boolean().optional(),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validasi Gagal', details: parsed.error.format() }, 400);
    }

    const [updated] = await db
      .update(outlets)
      .set({
        ...parsed.data,
        updatedAt: new Date(),
      })
      .where(and(eq(outlets.id, id), eq(outlets.tenantId, auth.tenantId)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Outlet tidak ditemukan' }, 404);
    }

    return c.json({ message: 'Outlet berhasil diperbarui', data: updated });
  } catch (error) {
    return c.json({ error: 'Server Error' }, 500);
  }
});

export default router;
