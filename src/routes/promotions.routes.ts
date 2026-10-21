import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { db } from '../db/index';
import { promotions } from '../db/schema/index';
import { eq, and, desc, sql, gte, lte } from 'drizzle-orm';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

// 1. LIST PROMOTIONS
router.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const search = query.search?.trim();
    const onlyActive = query.active === 'true';

    const conditions = [eq(promotions.tenantId, tenantId)];

    if (onlyActive) {
      conditions.push(eq(promotions.isActive, true));
      conditions.push(gte(promotions.endDate, new Date().toISOString().split('T')[0]));
    }

    if (search) {
      conditions.push(
        sql`(${promotions.code} ILIKE ${'%' + search + '%'} OR ${promotions.name} ILIKE ${'%' + search + '%'})`
      );
    }

    const rows = await db
      .select()
      .from(promotions)
      .where(and(...conditions))
      .orderBy(desc(promotions.createdAt));

    return c.json({
      success: true,
      data: rows,
    });
  } catch (error: any) {
    console.error('Error fetching promotions:', error);
    return c.json({ success: false, message: 'Gagal memuat promo & diskon', error: error.message }, 500);
  }
});

// 2. CREATE PROMOTION
const promotionSchema = z.object({
  code: z.string().min(2, 'Kode promo minimal 2 karakter').toUpperCase(),
  name: z.string().min(3, 'Nama promo minimal 3 karakter'),
  discountType: z.enum(['PERCENT', 'FIXED']).default('PERCENT'),
  discountValue: z.number().min(0.01, 'Nilai diskon harus lebih dari 0'),
  minPurchase: z.number().optional().default(0),
  maxDiscount: z.number().optional(),
  startDate: z.string().optional(),
  endDate: z.string().min(1, 'Tanggal berakhir promo wajib diisi'),
  customerType: z.enum(['ALL', 'MEMBER', 'RESEP']).default('ALL'),
  maxUsage: z.number().optional(),
});

router.post('/', requireRole(['owner', 'super_admin']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const validated = promotionSchema.parse(body);

    // Check unique code per tenant
    const [existing] = await db
      .select()
      .from(promotions)
      .where(and(eq(promotions.tenantId, tenantId), eq(promotions.code, validated.code)));

    if (existing) {
      return c.json({ success: false, message: 'Kode promo ini sudah digunakan' }, 400);
    }

    const [newPromo] = await db
      .insert(promotions)
      .values({
        tenantId,
        code: validated.code,
        name: validated.name,
        discountType: validated.discountType,
        discountValue: validated.discountValue.toString(),
        minPurchase: (validated.minPurchase || 0).toString(),
        maxDiscount: validated.maxDiscount ? validated.maxDiscount.toString() : null,
        startDate: validated.startDate || new Date().toISOString().split('T')[0],
        endDate: validated.endDate,
        customerType: validated.customerType,
        maxUsage: validated.maxUsage || null,
      })
      .returning();

    return c.json({
      success: true,
      message: 'Program promo & diskon berhasil dibuat',
      data: newPromo,
    }, 201);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    return c.json({ success: false, message: 'Gagal membuat promo', error: error.message }, 500);
  }
});

// 3. VALIDATE PROMO CODE AT POS
const validatePromoSchema = z.object({
  code: z.string().min(1),
  subtotal: z.number().min(0),
  customerType: z.string().optional().default('ALL'),
});

router.post('/validate', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const { code, subtotal, customerType } = validatePromoSchema.parse(body);

    const [promo] = await db
      .select()
      .from(promotions)
      .where(and(eq(promotions.tenantId, tenantId), eq(promotions.code, code.toUpperCase())));

    if (!promo) {
      return c.json({ success: false, message: 'Kode promo tidak ditemukan' }, 404);
    }

    if (!promo.isActive) {
      return c.json({ success: false, message: 'Promo ini sedang nonaktif' }, 400);
    }

    const today = new Date().toISOString().split('T')[0];
    if (promo.startDate > today) {
      return c.json({ success: false, message: `Promo baru aktif pada ${promo.startDate}` }, 400);
    }
    if (promo.endDate < today) {
      return c.json({ success: false, message: 'Masa berlaku promo ini telah berakhir' }, 400);
    }

    if (promo.maxUsage && promo.usageCount >= promo.maxUsage) {
      return c.json({ success: false, message: 'Kuota penggunaan promo ini sudah habis' }, 400);
    }

    const minPurchase = Number(promo.minPurchase || 0);
    if (subtotal < minPurchase) {
      return c.json({
        success: false,
        message: `Minimal belanja Rp ${minPurchase.toLocaleString('id-ID')} untuk menggunakan promo ini`,
      }, 400);
    }

    if (promo.customerType !== 'ALL' && promo.customerType !== customerType) {
      return c.json({
        success: false,
        message: `Promo ini khusus untuk tipe pelanggan: ${promo.customerType}`,
      }, 400);
    }

    // Calculate discount amount
    let discountAmount = 0;
    const discountVal = Number(promo.discountValue);

    if (promo.discountType === 'PERCENT') {
      discountAmount = (subtotal * discountVal) / 100;
      if (promo.maxDiscount && discountAmount > Number(promo.maxDiscount)) {
        discountAmount = Number(promo.maxDiscount);
      }
    } else {
      discountAmount = Math.min(subtotal, discountVal);
    }

    return c.json({
      success: true,
      message: 'Kode promo valid',
      data: {
        id: promo.id,
        code: promo.code,
        name: promo.name,
        discountType: promo.discountType,
        discountValue: discountVal,
        calculatedDiscount: discountAmount,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    return c.json({ success: false, message: 'Gagal memvalidasi promo', error: error.message }, 500);
  }
});

// 4. UPDATE PROMOTION STATUS / EDIT
router.put('/:id', requireRole(['owner', 'super_admin']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json();

    const [updated] = await db
      .update(promotions)
      .set({
        name: body.name,
        discountType: body.discountType,
        discountValue: body.discountValue?.toString(),
        minPurchase: body.minPurchase?.toString(),
        maxDiscount: body.maxDiscount ? body.maxDiscount.toString() : null,
        endDate: body.endDate,
        customerType: body.customerType,
        isActive: body.isActive,
        updatedAt: new Date(),
      })
      .where(and(eq(promotions.id, id), eq(promotions.tenantId, tenantId)))
      .returning();

    if (!updated) {
      return c.json({ success: false, message: 'Promo tidak ditemukan' }, 404);
    }

    return c.json({ success: true, message: 'Promo berhasil diperbarui', data: updated });
  } catch (error: any) {
    return c.json({ success: false, message: 'Gagal memperbarui promo', error: error.message }, 500);
  }
});

// 5. DELETE PROMOTION
router.delete('/:id', requireRole(['owner', 'super_admin']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');

    const [deleted] = await db
      .delete(promotions)
      .where(and(eq(promotions.id, id), eq(promotions.tenantId, tenantId)))
      .returning();

    if (!deleted) {
      return c.json({ success: false, message: 'Promo tidak ditemukan' }, 404);
    }

    return c.json({ success: true, message: 'Promo berhasil dihapus' });
  } catch (error: any) {
    return c.json({ success: false, message: 'Gagal menghapus promo', error: error.message }, 500);
  }
});

export default router;
