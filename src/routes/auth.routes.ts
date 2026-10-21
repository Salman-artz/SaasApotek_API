import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { authMiddleware } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limiter';
import { db } from '../db/index';
import { users, tenants, outlets } from '../db/schema/index';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

const router = new Hono();

// Rate limiter for authentication routes: max 10 requests per 15 minutes per IP
const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Terlalu banyak percobaan autentikasi dari alamat ini. Silakan coba lagi setelah 15 menit.',
});

// Helper to generate slug from company name
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// REGISTER NEW TENANT + OWNER USER + DEFAULT OUTLET
router.post('/register', authRateLimiter, async (c) => {
  try {
    const body = await c.req.json();
    const schema = z.object({
      pharmacyName: z.string().min(2, 'Nama apotek minimal 2 karakter'),
      ownerName: z.string().min(2, 'Nama pemilik minimal 2 karakter'),
      email: z.string().email('Format email tidak valid'),
      phone: z.string().optional(),
      password: z.string().min(6, 'Password minimal 6 karakter'),
      plan: z.enum(['starter', 'pro', 'enterprise']).default('starter'),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validasi Gagal', details: parsed.error.format() }, 400);
    }

    const { pharmacyName, ownerName, email, phone, password, plan } = parsed.data;

    // Check if email already registered
    const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existingUser.length > 0) {
      return c.json({ error: 'Email sudah terdaftar', message: 'Silakan gunakan email lain atau login' }, 409);
    }

    // Generate unique slug for tenant
    let baseSlug = slugify(pharmacyName) || 'apotek';
    let slug = baseSlug;
    let counter = 1;
    while (true) {
      const existingSlug = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
      if (existingSlug.length === 0) break;
      slug = `${baseSlug}-${counter++}`;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Create Tenant, Default Outlet, and Owner User inside transaction
    const result = await db.transaction(async (tx) => {
      const [newTenant] = await tx
        .insert(tenants)
        .values({
          name: pharmacyName,
          slug,
          plan,
          isActive: true,
        })
        .returning();

      const [defaultOutlet] = await tx
        .insert(outlets)
        .values({
          tenantId: newTenant.id,
          name: `${pharmacyName} - Cabang Utama`,
          phone: phone || null,
          isActive: true,
        })
        .returning();

      const [newUser] = await tx
        .insert(users)
        .values({
          tenantId: newTenant.id,
          outletId: defaultOutlet.id,
          fullName: ownerName,
          email,
          passwordHash,
          role: 'owner',
          isActive: true,
        })
        .returning();

      return { tenant: newTenant, outlet: defaultOutlet, user: newUser };
    });

    const payload = {
      id: result.user.id,
      tenantId: result.tenant.id,
      outletId: result.outlet.id,
      role: result.user.role,
      fullName: result.user.fullName,
      email: result.user.email,
    };

    const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: '7d' });

    setCookie(c, 'auth_token', token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'Lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    });

    return c.json({
      message: 'Pendaftaran berhasil! Selamat datang di Apotek Digital.',
      token,
      user: {
        id: result.user.id,
        fullName: result.user.fullName,
        email: result.user.email,
        role: result.user.role,
      },
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        slug: result.tenant.slug,
        plan: result.tenant.plan,
      },
      outlet: {
        id: result.outlet.id,
        name: result.outlet.name,
      },
    }, 201);
  } catch (error) {
    console.error('Register error:', error);
    return c.json({ error: 'Server Error', message: 'Gagal memproses pendaftaran' }, 500);
  }
});

// LOGIN
router.post('/login', authRateLimiter, async (c) => {
  try {
    const body = await c.req.json();
    const schema = z.object({
      email: z.string().email('Format email tidak valid'),
      password: z.string().min(1, 'Password wajib diisi'),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validasi Gagal', details: parsed.error.format() }, 400);
    }

    const { email, password } = parsed.data;

    const userRows = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const user = userRows[0];

    if (!user || !user.isActive) {
      return c.json({ error: 'Autentikasi Gagal', message: 'Email atau password tidak sesuai' }, 401);
    }

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      return c.json({ error: 'Autentikasi Gagal', message: 'Email atau password tidak sesuai' }, 401);
    }

    // Get Tenant & Outlet Details
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
    if (!tenant || !tenant.isActive) {
      return c.json({ error: 'Akun Dinonaktifkan', message: 'Akun apotek ini tidak aktif. Silakan hubungi admin.' }, 403);
    }

    let outlet = null;
    if (user.outletId) {
      const [outletRow] = await db.select().from(outlets).where(eq(outlets.id, user.outletId)).limit(1);
      outlet = outletRow || null;
    }

    // If user has no outlet assigned, pick the first active outlet of the tenant
    if (!outlet) {
      const outletRows = await db.select().from(outlets).where(and(eq(outlets.tenantId, tenant.id), eq(outlets.isActive, true))).limit(1);
      outlet = outletRows[0] || null;
    }

    const payload = {
      id: user.id,
      tenantId: tenant.id,
      outletId: outlet?.id || null,
      role: user.role,
      fullName: user.fullName,
      email: user.email,
    };

    const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: '7d' });

    setCookie(c, 'auth_token', token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'Lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    });

    return c.json({
      message: 'Login berhasil',
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.plan,
      },
      outlet: outlet ? {
        id: outlet.id,
        name: outlet.name,
      } : null,
    });
  } catch (error) {
    console.error('Login error:', error);
    return c.json({ error: 'Server Error', message: 'Gagal memproses login' }, 500);
  }
});

// GET CURRENT USER (/me)
router.get('/me', authMiddleware, async (c) => {
  try {
    const auth = c.get('user');
    const [user] = await db.select().from(users).where(eq(users.id, auth.id)).limit(1);
    if (!user) {
      return c.json({ error: 'User tidak ditemukan' }, 404);
    }

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
    const tenantOutlets = await db.select().from(outlets).where(and(eq(outlets.tenantId, user.tenantId), eq(outlets.isActive, true)));

    let activeOutlet = tenantOutlets.find((o) => o.id === auth.outletId) || tenantOutlets[0] || null;

    return c.json({
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      },
      tenant: {
        id: tenant?.id,
        name: tenant?.name,
        slug: tenant?.slug,
        plan: tenant?.plan,
      },
      activeOutlet: activeOutlet ? {
        id: activeOutlet.id,
        name: activeOutlet.name,
        address: activeOutlet.address,
        phone: activeOutlet.phone,
        siaNumber: activeOutlet.siaNumber,
        sipaNumber: activeOutlet.sipaNumber,
      } : null,
      availableOutlets: tenantOutlets.map((o) => ({
        id: o.id,
        name: o.name,
      })),
    });
  } catch (error) {
    console.error('Me error:', error);
    return c.json({ error: 'Server Error' }, 500);
  }
});

// SWITCH ACTIVE OUTLET
router.post('/switch-outlet', authMiddleware, async (c) => {
  try {
    const auth = c.get('user');
    const body = await c.req.json();
    const { outletId } = z.object({ outletId: z.string().uuid() }).parse(body);

    // Verify outlet belongs to user's tenant
    const [targetOutlet] = await db
      .select()
      .from(outlets)
      .where(and(eq(outlets.id, outletId), eq(outlets.tenantId, auth.tenantId)))
      .limit(1);

    if (!targetOutlet) {
      return c.json({ error: 'Outlet tidak ditemukan atau tidak memiliki akses' }, 404);
    }

    // Issue updated token with new active outlet
    const payload = {
      ...auth,
      outletId: targetOutlet.id,
    };

    const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: '7d' });

    return c.json({
      message: `Berhasil beralih ke cabang ${targetOutlet.name}`,
      token,
      outlet: {
        id: targetOutlet.id,
        name: targetOutlet.name,
      },
    });
  } catch (error) {
    return c.json({ error: 'Bad Request', message: 'Gagal beralih outlet' }, 400);
  }
});

// ONBOARDING SETUP OUTLET DETAILS
router.post('/onboarding', authMiddleware, async (c) => {
  try {
    const auth = c.get('user');
    const body = await c.req.json();
    const schema = z.object({
      address: z.string().min(5, 'Alamat wajib diisi'),
      phone: z.string().min(8, 'Nomor telepon wajib diisi'),
      siaNumber: z.string().optional(),
      sipaNumber: z.string().optional(),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validasi Gagal', details: parsed.error.format() }, 400);
    }

    if (!auth.outletId) {
      return c.json({ error: 'Outlet aktif tidak ditemukan' }, 400);
    }

    const [updatedOutlet] = await db
      .update(outlets)
      .set({
        address: parsed.data.address,
        phone: parsed.data.phone,
        siaNumber: parsed.data.siaNumber || null,
        sipaNumber: parsed.data.sipaNumber || null,
        updatedAt: new Date(),
      })
      .where(and(eq(outlets.id, auth.outletId), eq(outlets.tenantId, auth.tenantId)))
      .returning();

    return c.json({
      message: 'Pengaturan outlet awal berhasil disimpan!',
      outlet: updatedOutlet,
    });
  } catch (error) {
    console.error('Onboarding error:', error);
    return c.json({ error: 'Server Error', message: 'Gagal menyimpan onboarding' }, 500);
  }
});

// LOGOUT
router.post('/logout', authMiddleware, async (c) => {
  deleteCookie(c, 'auth_token', {
    path: '/',
    secure: env.NODE_ENV === 'production',
    sameSite: 'Lax',
  });
  return c.json({ message: 'Logout berhasil' });
});

export default router;
