import { outlets, suppliers, products, shiftSessions } from '../db/schema/index';
import { eq, and, inArray } from 'drizzle-orm';

export class TenantSecurityError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 403) {
    super(message);
    this.name = 'TenantSecurityError';
    this.statusCode = statusCode;
  }
}

export async function assertOutletBelongsToTenant(
  client: any,
  outletId: string,
  tenantId: string
) {
  const [outlet] = await client
    .select({ id: outlets.id })
    .from(outlets)
    .where(and(eq(outlets.id, outletId), eq(outlets.tenantId, tenantId)))
    .limit(1);

  if (!outlet) {
    throw new TenantSecurityError('Outlet tidak ditemukan atau Anda tidak memiliki akses ke outlet ini');
  }
  return outlet;
}

export async function assertSupplierBelongsToTenant(
  client: any,
  supplierId: string,
  tenantId: string
) {
  const [supplier] = await client
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.tenantId, tenantId)))
    .limit(1);

  if (!supplier) {
    throw new TenantSecurityError('Supplier tidak ditemukan atau Anda tidak memiliki akses ke supplier ini');
  }
  return supplier;
}

export async function assertProductsBelongToTenant(
  client: any,
  productIds: string[],
  tenantId: string
) {
  const uniqueIds = Array.from(new Set(productIds));
  if (uniqueIds.length === 0) return;

  const foundProducts = await client
    .select({ id: products.id })
    .from(products)
    .where(and(inArray(products.id, uniqueIds), eq(products.tenantId, tenantId)));

  if (foundProducts.length !== uniqueIds.length) {
    throw new TenantSecurityError('Satu atau lebih produk tidak ditemukan atau tidak termasuk dalam tenant Anda');
  }
}

export async function assertShiftBelongsToTenant(
  client: any,
  shiftSessionId: string,
  tenantId: string
) {
  const [shift] = await client
    .select({ id: shiftSessions.id })
    .from(shiftSessions)
    .where(and(eq(shiftSessions.id, shiftSessionId), eq(shiftSessions.tenantId, tenantId)))
    .limit(1);

  if (!shift) {
    throw new TenantSecurityError('Sesi shift kasir tidak valid atau tidak termasuk dalam tenant Anda');
  }
  return shift;
}
