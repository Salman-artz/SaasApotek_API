import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { db } from '../db/index';
import { products, productUnits, productBatches } from '../db/schema/index';
import { eq, and, or, ilike, sql } from 'drizzle-orm';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

// LIST PRODUCTS WITH UNITS AND STOCK SUMMARY
router.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const search = query.search?.trim();
    const category = query.category?.trim();
    const requiresPrescription = query.requiresPrescription;
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const conditions = [eq(products.tenantId, tenantId), eq(products.isActive, true)];

    if (search) {
      conditions.push(
        or(
          ilike(products.name, `%${search}%`),
          ilike(products.genericName, `%${search}%`),
          ilike(products.barcode, `%${search}%`),
          ilike(products.sku, `%${search}%`)
        )!
      );
    }

    if (category && category !== 'Semua') {
      conditions.push(eq(products.category, category));
    }

    if (requiresPrescription !== undefined && requiresPrescription !== '') {
      conditions.push(eq(products.requiresPrescription, requiresPrescription === 'true'));
    }

    const whereClause = and(...conditions);

    // Get total count
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(whereClause);

    const total = countResult?.count || 0;

    // Get products with pagination
    const productList = await db
      .select()
      .from(products)
      .where(whereClause)
      .limit(limit)
      .offset(offset)
      .orderBy(products.name);

    if (productList.length === 0) {
      return c.json({
        data: [],
        meta: { page, limit, total, totalPages: 0 },
      });
    }

    const productIds = productList.map((p) => p.id);

    // Fetch units for all returned products
    const units = await db
      .select()
      .from(productUnits)
      .where(sql`${productUnits.productId} IN ${productIds}`);

    // Fetch stock summary from active batches
    const stockSummary = await db
      .select({
        productId: productBatches.productId,
        totalStock: sql<number>`sum(${productBatches.stockInBaseUnit})::int`,
      })
      .from(productBatches)
      .where(and(eq(productBatches.tenantId, tenantId), sql`${productBatches.productId} IN ${productIds}`))
      .groupBy(productBatches.productId);

    const stockMap = new Map(stockSummary.map((s) => [s.productId, s.totalStock || 0]));

    const result = productList.map((p) => ({
      ...p,
      totalStock: stockMap.get(p.id) || 0,
      units: units.filter((u) => u.productId === p.id),
    }));

    return c.json({
      data: result,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Fetch products error:', error);
    return c.json({ error: 'Server Error', message: 'Gagal memuat katalog produk' }, 500);
  }
});

// BARCODE LOOKUP FOR SCANNER
router.get('/barcode/:code', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const code = c.req.param('code').trim();

    const [product] = await db
      .select()
      .from(products)
      .where(
        and(
          eq(products.tenantId, tenantId),
          eq(products.isActive, true),
          or(eq(products.barcode, code), eq(products.sku, code))
        )
      )
      .limit(1);

    if (!product) {
      return c.json({ error: 'Produk tidak ditemukan', message: `Tidak ada obat dengan barcode/SKU ${code}` }, 404);
    }

    const units = await db
      .select()
      .from(productUnits)
      .where(eq(productUnits.productId, product.id));

    const batches = await db
      .select()
      .from(productBatches)
      .where(and(eq(productBatches.productId, product.id), eq(productBatches.tenantId, tenantId)))
      .orderBy(productBatches.expiredDate);

    const totalStock = batches.reduce((acc, b) => acc + (b.stockInBaseUnit || 0), 0);

    return c.json({
      data: {
        ...product,
        totalStock,
        units,
        batches,
      },
    });
  } catch (error) {
    return c.json({ error: 'Server Error', message: 'Gagal mencari barcode' }, 500);
  }
});

// GET PRODUCT DETAIL
router.get('/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');

    const [product] = await db
      .select()
      .from(products)
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)))
      .limit(1);

    if (!product) {
      return c.json({ error: 'Produk tidak ditemukan' }, 404);
    }

    const units = await db
      .select()
      .from(productUnits)
      .where(eq(productUnits.productId, product.id));

    const batches = await db
      .select()
      .from(productBatches)
      .where(and(eq(productBatches.productId, product.id), eq(productBatches.tenantId, tenantId)))
      .orderBy(productBatches.expiredDate);

    const totalStock = batches.reduce((acc, b) => acc + (b.stockInBaseUnit || 0), 0);

    return c.json({
      data: {
        ...product,
        totalStock,
        units,
        batches,
      },
    });
  } catch (error) {
    return c.json({ error: 'Server Error' }, 500);
  }
});

// CREATE NEW PRODUCT WITH MULTI-UNITS
router.post('/', requireRole(['owner', 'super_admin', 'pharmacist', 'inventory']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();

    const unitSchema = z.object({
      unitName: z.string().min(1, 'Nama satuan wajib diisi'),
      conversionFactor: z.number().int().positive('Faktor konversi minimal 1'),
      buyPrice: z.union([z.string(), z.number()]).transform(String),
      sellPrice: z.union([z.string(), z.number()]).transform(String),
      isBaseUnit: z.boolean().default(false),
    });

    const createProductSchema = z.object({
      name: z.string().min(2, 'Nama obat minimal 2 karakter'),
      genericName: z.string().optional(),
      sku: z.string().optional(),
      barcode: z.string().optional(),
      category: z.enum([
        'Bebas',
        'Bebas Terbatas',
        'Keras',
        'Narkotika',
        'Psikotropika',
        'Alkes',
        'Herbal / Jamu',
      ]),
      requiresPrescription: z.boolean().default(false),
      minStockAlert: z.number().int().nonnegative().default(10),
      baseUnit: z.string().min(1, 'Satuan terkecil wajib diisi (misal: Tablet, Kapsul, Botol)'),
      units: z.array(unitSchema).min(1, 'Minimal harus ada 1 satuan dasar'),
    });

    const parsed = createProductSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validasi Gagal', details: parsed.error.format() }, 400);
    }

    const data = parsed.data;

    // Ensure base unit is included in units array
    const hasBaseUnit = data.units.some((u) => u.isBaseUnit || u.conversionFactor === 1);
    if (!hasBaseUnit) {
      data.units.push({
        unitName: data.baseUnit,
        conversionFactor: 1,
        buyPrice: '0',
        sellPrice: '0',
        isBaseUnit: true,
      });
    }

    // Insert Product and Units in single transaction
    const result = await db.transaction(async (tx) => {
      const [newProduct] = await tx
        .insert(products)
        .values({
          tenantId,
          name: data.name,
          genericName: data.genericName || null,
          sku: data.sku || null,
          barcode: data.barcode || null,
          category: data.category,
          requiresPrescription: data.requiresPrescription,
          minStockAlert: data.minStockAlert,
          baseUnit: data.baseUnit,
          isActive: true,
        })
        .returning();

      const unitsToInsert = data.units.map((u) => ({
        productId: newProduct.id,
        unitName: u.unitName,
        conversionFactor: u.conversionFactor,
        buyPrice: String(u.buyPrice),
        sellPrice: String(u.sellPrice),
        isBaseUnit: u.conversionFactor === 1 || u.isBaseUnit,
      }));

      const insertedUnits = await tx.insert(productUnits).values(unitsToInsert).returning();

      return { product: newProduct, units: insertedUnits };
    });

    return c.json({
      message: 'Obat / produk baru berhasil ditambahkan',
      data: {
        ...result.product,
        totalStock: 0,
        units: result.units,
      },
    }, 201);
  } catch (error) {
    console.error('Create product error:', error);
    return c.json({ error: 'Server Error', message: 'Gagal menambahkan produk baru' }, 500);
  }
});

// UPDATE PRODUCT & MULTI-UNITS
router.put('/:id', requireRole(['owner', 'super_admin', 'pharmacist', 'inventory']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');
    const body = await c.req.json();

    const unitSchema = z.object({
      id: z.string().uuid().optional(),
      unitName: z.string().min(1),
      conversionFactor: z.number().int().positive(),
      buyPrice: z.union([z.string(), z.number()]).transform(String),
      sellPrice: z.union([z.string(), z.number()]).transform(String),
      isBaseUnit: z.boolean().default(false),
    });

    const updateSchema = z.object({
      name: z.string().min(2).optional(),
      genericName: z.string().nullable().optional(),
      sku: z.string().nullable().optional(),
      barcode: z.string().nullable().optional(),
      category: z.enum([
        'Bebas',
        'Bebas Terbatas',
        'Keras',
        'Narkotika',
        'Psikotropika',
        'Alkes',
        'Herbal / Jamu',
      ]).optional(),
      requiresPrescription: z.boolean().optional(),
      minStockAlert: z.number().int().nonnegative().optional(),
      baseUnit: z.string().min(1).optional(),
      isActive: z.boolean().optional(),
      units: z.array(unitSchema).optional(),
    });

    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validasi Gagal', details: parsed.error.format() }, 400);
    }

    const data = parsed.data;

    const result = await db.transaction(async (tx) => {
      const updateFields: Record<string, any> = { updatedAt: new Date() };
      if (data.name !== undefined) updateFields.name = data.name;
      if (data.genericName !== undefined) updateFields.genericName = data.genericName;
      if (data.sku !== undefined) updateFields.sku = data.sku;
      if (data.barcode !== undefined) updateFields.barcode = data.barcode;
      if (data.category !== undefined) updateFields.category = data.category;
      if (data.requiresPrescription !== undefined) updateFields.requiresPrescription = data.requiresPrescription;
      if (data.minStockAlert !== undefined) updateFields.minStockAlert = data.minStockAlert;
      if (data.baseUnit !== undefined) updateFields.baseUnit = data.baseUnit;
      if (data.isActive !== undefined) updateFields.isActive = data.isActive;

      const [updatedProduct] = await tx
        .update(products)
        .set(updateFields)
        .where(and(eq(products.id, id), eq(products.tenantId, tenantId)))
        .returning();

      if (!updatedProduct) {
        throw new Error('NOT_FOUND');
      }

      if (data.units && data.units.length > 0) {
        // Delete previous units and recreate
        await tx.delete(productUnits).where(eq(productUnits.productId, id));

        const unitsToInsert = data.units.map((u) => ({
          productId: id,
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          buyPrice: String(u.buyPrice),
          sellPrice: String(u.sellPrice),
          isBaseUnit: u.conversionFactor === 1 || u.isBaseUnit,
        }));

        const insertedUnits = await tx.insert(productUnits).values(unitsToInsert).returning();
        return { product: updatedProduct, units: insertedUnits };
      }

      const existingUnits = await tx.select().from(productUnits).where(eq(productUnits.productId, id));
      return { product: updatedProduct, units: existingUnits };
    });

    return c.json({
      message: 'Produk berhasil diperbarui',
      data: {
        ...result.product,
        units: result.units,
      },
    });
  } catch (error: any) {
    if (error.message === 'NOT_FOUND') {
      return c.json({ error: 'Produk tidak ditemukan' }, 404);
    }
    console.error('Update product error:', error);
    return c.json({ error: 'Server Error', message: 'Gagal memperbarui produk' }, 500);
  }
});

// DELETE PRODUCT (SOFT DELETE) - OWNER & SUPER_ADMIN ONLY
router.delete('/:id', requireRole(['owner', 'super_admin']), async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');

    const [deleted] = await db
      .update(products)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)))
      .returning();

    if (!deleted) {
      return c.json({ error: 'Produk tidak ditemukan' }, 404);
    }

    return c.json({ message: 'Produk berhasil dihapus dari katalog' });
  } catch (error) {
    return c.json({ error: 'Server Error' }, 500);
  }
});

export default router;
