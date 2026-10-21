import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as dotenv from 'dotenv';
import { tenants, outlets, products, productUnits, productBatches, suppliers } from './schema/index';
import { eq } from 'drizzle-orm';

dotenv.config();

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(sql);

async function seed() {
  console.log('🌱 Seeding initial pharmacy master data...');

  try {
    // Get existing tenant and outlet
    const tenantList = await db.select().from(tenants).limit(1);
    if (tenantList.length === 0) {
      console.log('⚠️ No tenant found. Please register a tenant first via /register.');
      return;
    }

    const tenantId = tenantList[0].id;
    const outletList = await db.select().from(outlets).where(eq(outlets.tenantId, tenantId)).limit(1);
    const outletId = outletList[0].id;

    // 1. Seed Top PBF Suppliers
    console.log('📦 Seeding Top PBF Suppliers...');
    const supplierData = [
      { name: 'PT. Enseval Putera Megatrading Tbk', phone: '021-4609042', address: 'Kawasan Industri Pulogadung, Jakarta Timur' },
      { name: 'PT. Kimia Farma Trading & Distribution', phone: '021-3847709', address: 'Jl. Budi Utomo No. 1, Jakarta Pusat' },
      { name: 'PT. Mensa Bina Sukses (MBS)', phone: '021-5819777', address: 'Puri Indah Financial Tower, Jakarta Barat' },
      { name: 'PT. Anugrah Argon Medica (AAM)', phone: '021-8990123', address: 'Cikarang Barat, Bekasi' },
    ];

    for (const sup of supplierData) {
      const existing = await db.select().from(suppliers).where(eq(suppliers.name, sup.name)).limit(1);
      if (existing.length === 0) {
        await db.insert(suppliers).values({ ...sup, tenantId, isActive: true });
      }
    }

    // 2. Seed Standard Medicines with Multi-Units and Batches
    console.log('💊 Seeding Standard Indonesian Medicines & Multi-Units...');
    const standardMedicines = [
      {
        name: 'Paracetamol 500mg Kaplet',
        genericName: 'Paracetamol 500mg',
        sku: 'PCT-500',
        barcode: '899123456001',
        category: 'Bebas',
        requiresPrescription: false,
        minStockAlert: 50,
        baseUnit: 'Tablet',
        units: [
          { unitName: 'Box', conversionFactor: 100, buyPrice: '45000', sellPrice: '65000', isBaseUnit: false },
          { unitName: 'Strip', conversionFactor: 10, buyPrice: '5000', sellPrice: '7000', isBaseUnit: false },
          { unitName: 'Tablet', conversionFactor: 1, buyPrice: '500', sellPrice: '800', isBaseUnit: true },
        ],
        batch: { batchNumber: 'PCT-2025-01', expiredDate: '2027-08-30', stock: 250, cost: '500' },
      },
      {
        name: 'Amoxicillin 500mg Kapsul',
        genericName: 'Amoxicillin Trihydrate 500mg',
        sku: 'AMX-500',
        barcode: '899123456002',
        category: 'Keras',
        requiresPrescription: true,
        minStockAlert: 30,
        baseUnit: 'Kapsul',
        units: [
          { unitName: 'Box', conversionFactor: 100, buyPrice: '70000', sellPrice: '95000', isBaseUnit: false },
          { unitName: 'Strip', conversionFactor: 10, buyPrice: '7500', sellPrice: '10500', isBaseUnit: false },
          { unitName: 'Kapsul', conversionFactor: 1, buyPrice: '750', sellPrice: '1200', isBaseUnit: true },
        ],
        batch: { batchNumber: 'AMX-2024-09', expiredDate: '2026-11-15', stock: 120, cost: '750' }, // FEFO near expiry
      },
      {
        name: 'Omeprazole 20mg Kapsul',
        genericName: 'Omeprazole 20mg',
        sku: 'OMZ-20',
        barcode: '899123456003',
        category: 'Keras',
        requiresPrescription: true,
        minStockAlert: 20,
        baseUnit: 'Kapsul',
        units: [
          { unitName: 'Box', conversionFactor: 30, buyPrice: '35000', sellPrice: '50000', isBaseUnit: false },
          { unitName: 'Strip', conversionFactor: 10, buyPrice: '12000', sellPrice: '18000', isBaseUnit: false },
          { unitName: 'Kapsul', conversionFactor: 1, buyPrice: '1200', sellPrice: '2000', isBaseUnit: true },
        ],
        batch: { batchNumber: 'OMZ-221A', expiredDate: '2027-03-10', stock: 80, cost: '1200' },
      },
      {
        name: 'Cetirizine 10mg Tablet',
        genericName: 'Cetirizine Dihydrochloride 10mg',
        sku: 'CTZ-10',
        barcode: '899123456004',
        category: 'Bebas Terbatas',
        requiresPrescription: false,
        minStockAlert: 20,
        baseUnit: 'Tablet',
        units: [
          { unitName: 'Box', conversionFactor: 50, buyPrice: '30000', sellPrice: '45000', isBaseUnit: false },
          { unitName: 'Strip', conversionFactor: 10, buyPrice: '6500', sellPrice: '10000', isBaseUnit: false },
          { unitName: 'Tablet', conversionFactor: 1, buyPrice: '650', sellPrice: '1100', isBaseUnit: true },
        ],
        batch: { batchNumber: 'CTZ-2025-04', expiredDate: '2027-06-20', stock: 150, cost: '650' },
      },
      {
        name: 'Antasida Doen Tablet Kunyah',
        genericName: 'Aluminium Hidroksida & Magnesium Hidroksida',
        sku: 'ATD-DOEN',
        barcode: '899123456005',
        category: 'Bebas',
        requiresPrescription: false,
        minStockAlert: 40,
        baseUnit: 'Tablet',
        units: [
          { unitName: 'Box', conversionFactor: 100, buyPrice: '22000', sellPrice: '35000', isBaseUnit: false },
          { unitName: 'Strip', conversionFactor: 10, buyPrice: '2500', sellPrice: '4000', isBaseUnit: false },
          { unitName: 'Tablet', conversionFactor: 1, buyPrice: '250', sellPrice: '500', isBaseUnit: true },
        ],
        batch: { batchNumber: 'ATD-2025-02', expiredDate: '2027-12-01', stock: 300, cost: '250' },
      },
      {
        name: 'Sanmol Sirup Paracetamol 60ml',
        genericName: 'Paracetamol 120mg/5ml',
        sku: 'SANMOL-SYR',
        barcode: '899123456006',
        category: 'Bebas',
        requiresPrescription: false,
        minStockAlert: 10,
        baseUnit: 'Botol',
        units: [
          { unitName: 'Karton', conversionFactor: 24, buyPrice: '480000', sellPrice: '576000', isBaseUnit: false },
          { unitName: 'Botol', conversionFactor: 1, buyPrice: '20000', sellPrice: '26000', isBaseUnit: true },
        ],
        batch: { batchNumber: 'PCT-SYR-03', expiredDate: '2027-02-28', stock: 18, cost: '20000' },
      },
      {
        name: 'Tensimeter Digital Beurer BM28',
        genericName: 'Alat Cek Tekanan Darah Otomatis',
        sku: 'ALKES-TENSI',
        barcode: '899123456007',
        category: 'Alkes',
        requiresPrescription: false,
        minStockAlert: 3,
        baseUnit: 'Pcs',
        units: [
          { unitName: 'Pcs', conversionFactor: 1, buyPrice: '380000', sellPrice: '485000', isBaseUnit: true },
        ],
        batch: { batchNumber: 'BEUR-2025', expiredDate: '2030-01-01', stock: 8, cost: '380000' },
      },
    ];

    for (const med of standardMedicines) {
      const existing = await db.select().from(products).where(eq(products.sku, med.sku)).limit(1);
      if (existing.length === 0) {
        const [insertedProduct] = await db
          .insert(products)
          .values({
            tenantId,
            name: med.name,
            genericName: med.genericName,
            sku: med.sku,
            barcode: med.barcode,
            category: med.category,
            requiresPrescription: med.requiresPrescription,
            minStockAlert: med.minStockAlert,
            baseUnit: med.baseUnit,
            isActive: true,
          })
          .returning();

        // Insert units
        const unitsToInsert = med.units.map((u) => ({
          productId: insertedProduct.id,
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          buyPrice: u.buyPrice,
          sellPrice: u.sellPrice,
          isBaseUnit: u.isBaseUnit,
        }));
        await db.insert(productUnits).values(unitsToInsert);

        // Insert initial batch & stock
        if (med.batch) {
          await db.insert(productBatches).values({
            tenantId,
            outletId,
            productId: insertedProduct.id,
            batchNumber: med.batch.batchNumber,
            expiredDate: med.batch.expiredDate,
            stockInBaseUnit: med.batch.stock,
            costPerBaseUnit: med.batch.cost,
          });
        }
      }
    }

    console.log('✅ Seeding completed successfully!');
  } catch (error) {
    console.error('❌ Seeding error:', error);
  } finally {
    await sql.end();
  }
}

seed();
