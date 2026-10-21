import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { db } from '../db/index';
import { users, outlets } from '../db/schema/index';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { assertOutletBelongsToTenant, TenantSecurityError } from '../lib/tenant-validator';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

// LIST USERS FOR CURRENT TENANT
router.get('/', requireRole(['owner', 'super_admin', 'pharmacist']), async (c) => {
  try {
    const auth = c.get('user');
    const rows = await db
      .select({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        role: users.role,
        outletId: users.outletId,
        outletName: outlets.name,
        isActive: users.isActive,
        createdAt: users.createdAt,
      })
      .from(users)
      .leftJoin(outlets, eq(users.outletId, outlets.id))
      .where(eq(users.tenantId, auth.tenantId));

    return c.json({ data: rows });
  } catch (error) {
    return c.json({ error: 'Server Error', message: 'Gagal mengambil data user' }, 500);
  }
});

// CREATE / INVITE NEW STAFF USER
router.post('/', async (c) => {
  try {
    const auth = c.get('user');
    if (auth.role !== 'owner' && auth.role !== 'super_admin') {
      return c.json({ error: 'Akses Ditolak', message: 'Hanya Owner yang dapat menambah staf' }, 403);
    }

    const body = await c.req.json();
    const schema = z.object({
      fullName: z.string().min(2, 'Nama minimal 2 karakter'),
      email: z.string().email('Format email tidak valid'),
      password: z.string().min(6, 'Password minimal 6 karakter'),
      role: z.enum(['pharmacist', 'cashier', 'inventory', 'owner']),
      outletId: z.string().uuid().optional(),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validasi Gagal', details: parsed.error.format() }, 400);
    }

    // Cross-Tenant IDOR Protection
    if (parsed.data.outletId) {
      await assertOutletBelongsToTenant(db, parsed.data.outletId, auth.tenantId);
    }

    // Check existing email
    const existing = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
    if (existing.length > 0) {
      return c.json({ error: 'Email sudah terdaftar', message: 'Silakan gunakan email lain' }, 409);
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 10);

    const [newUser] = await db
      .insert(users)
      .values({
        tenantId: auth.tenantId,
        outletId: parsed.data.outletId || auth.outletId || null,
        fullName: parsed.data.fullName,
        email: parsed.data.email,
        passwordHash,
        role: parsed.data.role,
        isActive: true,
      })
      .returning({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        role: users.role,
        outletId: users.outletId,
        isActive: users.isActive,
        createdAt: users.createdAt,
      });

    return c.json({ message: 'Staf baru berhasil ditambahkan', data: newUser }, 201);
  } catch (error: any) {
    if (error instanceof TenantSecurityError) {
      return c.json({ error: 'Forbidden', message: error.message }, error.statusCode as any);
    }
    console.error('Create user error:', error);
    return c.json({ error: 'Server Error', message: 'Gagal menambahkan staf' }, 500);
  }
});

// UPDATE USER
router.put('/:id', async (c) => {
  try {
    const auth = c.get('user');
    if (auth.role !== 'owner' && auth.role !== 'super_admin') {
      return c.json({ error: 'Akses Ditolak' }, 403);
    }

    const id = c.req.param('id');
    const body = await c.req.json();
    const schema = z.object({
      fullName: z.string().min(2).optional(),
      role: z.enum(['pharmacist', 'cashier', 'inventory', 'owner']).optional(),
      outletId: z.string().uuid().nullable().optional(),
      isActive: z.boolean().optional(),
      password: z.string().min(6).optional(),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validasi Gagal', details: parsed.error.format() }, 400);
    }

    // Cross-Tenant IDOR Protection
    if (parsed.data.outletId) {
      await assertOutletBelongsToTenant(db, parsed.data.outletId, auth.tenantId);
    }

    const updateData: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (parsed.data.fullName !== undefined) updateData.fullName = parsed.data.fullName;
    if (parsed.data.role !== undefined) updateData.role = parsed.data.role;
    if (parsed.data.outletId !== undefined) updateData.outletId = parsed.data.outletId;
    if (parsed.data.isActive !== undefined) updateData.isActive = parsed.data.isActive;
    if (parsed.data.password) {
      updateData.passwordHash = await bcrypt.hash(parsed.data.password, 10);
    }

    const [updated] = await db
      .update(users)
      .set(updateData)
      .where(and(eq(users.id, id), eq(users.tenantId, auth.tenantId)))
      .returning({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        role: users.role,
        outletId: users.outletId,
        isActive: users.isActive,
      });

    if (!updated) {
      return c.json({ error: 'User tidak ditemukan' }, 404);
    }

    return c.json({ message: 'Data user berhasil diperbarui', data: updated });
  } catch (error: any) {
    if (error instanceof TenantSecurityError) {
      return c.json({ error: 'Forbidden', message: error.message }, error.statusCode as any);
    }
    return c.json({ error: 'Server Error' }, 500);
  }
});

export default router;
