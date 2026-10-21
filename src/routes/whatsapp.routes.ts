import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { db } from '../db/index';
import { transactions, transactionItems, products, productUnits, tenants, outlets } from '../db/schema/index';
import { eq, and } from 'drizzle-orm';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

// 1. GENERATE WHATSAPP RECEIPT MESSAGE PAYLOAD
const receiptReqSchema = z.object({
  transactionId: z.string().uuid('ID Transaksi tidak valid'),
  phone: z.string().optional(),
});

router.post('/generate-receipt', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const { transactionId, phone: customPhone } = receiptReqSchema.parse(body);

    // Fetch tenant & outlet info
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    const [trx] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, transactionId), eq(transactions.tenantId, tenantId)));

    if (!trx) {
      return c.json({ success: false, message: 'Transaksi tidak ditemukan' }, 404);
    }

    let outletInfo = null;
    if (trx.outletId) {
      const [out] = await db.select().from(outlets).where(eq(outlets.id, trx.outletId));
      outletInfo = out;
    }

    // Fetch transaction items
    const items = await db
      .select({
        productName: products.name,
        quantity: transactionItems.quantity,
        unitName: productUnits.unitName,
        unitPrice: transactionItems.unitPrice,
        subtotal: transactionItems.subtotal,
      })
      .from(transactionItems)
      .innerJoin(products, eq(transactionItems.productId, products.id))
      .leftJoin(productUnits, eq(transactionItems.unitId, productUnits.id))
      .where(eq(transactionItems.transactionId, transactionId));

    const targetPhone = (customPhone || trx.customerPhone || '').replace(/\D/g, '');
    let formattedPhone = targetPhone;
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '62' + formattedPhone.slice(1);
    } else if (formattedPhone.startsWith('8')) {
      formattedPhone = '62' + formattedPhone;
    }

    const pharmacyName = outletInfo?.name || tenant?.name || 'Apotek Digital';
    const dateFormatted = new Date(trx.createdAt).toLocaleString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    // Build structured WhatsApp message
    let message = `🏥 *STRUK PEMBELIAN DIGITAL — ${pharmacyName.toUpperCase()}*\n`;
    if (outletInfo?.siaNumber) {
      message += `📜 SIA: ${outletInfo.siaNumber}\n`;
    }
    if (outletInfo?.address) {
      message += `📍 ${outletInfo.address}\n`;
    }
    message += `-------------------------------------------\n`;
    message += `🧾 *No. Faktur:* ${trx.invoiceCode}\n`;
    message += `📅 *Tanggal:* ${dateFormatted}\n`;
    message += `👤 *Pelanggan:* ${trx.customerName || 'Pelanggan Umum'}\n`;
    if (trx.isPrescription && trx.doctorName) {
      message += `🩺 *Dokter:* ${trx.doctorName} (Resep: ${trx.prescriptionNumber || '-'})\n`;
    }
    message += `💳 *Pembayaran:* ${trx.paymentMethod} (${trx.paymentStatus})\n`;
    message += `-------------------------------------------\n`;
    message += `*RINCIAN OBAT / PRODUK:*\n`;

    items.forEach((item, idx) => {
      message += `${idx + 1}. *${item.productName}*\n`;
      message += `   ${item.quantity} ${item.unitName || 'Pcs'} x Rp ${Number(item.unitPrice).toLocaleString('id-ID')} = *Rp ${Number(item.subtotal).toLocaleString('id-ID')}*\n`;
    });

    message += `-------------------------------------------\n`;
    message += `Subtotal: Rp ${Number(trx.totalSubtotal).toLocaleString('id-ID')}\n`;
    if (Number(trx.discountAmount) > 0) {
      message += `Diskon/Promo: -Rp ${Number(trx.discountAmount).toLocaleString('id-ID')}\n`;
    }
    if (Number(trx.taxAmount) > 0) {
      message += `PPN (11%): Rp ${Number(trx.taxAmount).toLocaleString('id-ID')}\n`;
    }
    message += `*TOTAL BAYAR: Rp ${Number(trx.grandTotal).toLocaleString('id-ID')}*\n`;
    message += `-------------------------------------------\n`;
    message += `💊 *Konsultasi & Aturan Pakai:* Konsumsi obat sesuai petunjuk Apoteker/Dokter.\n`;
    message += `🙏 *Terima kasih atas kunjungan Anda. Semoga lekas sembuh!*\n`;

    const waLink = formattedPhone
      ? `https://wa.me/${formattedPhone}?text=${encodeURIComponent(message)}`
      : `https://wa.me/?text=${encodeURIComponent(message)}`;

    return c.json({
      success: true,
      data: {
        phone: formattedPhone,
        customerName: trx.customerName,
        invoiceCode: trx.invoiceCode,
        message,
        waLink,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    console.error('Error generating WhatsApp receipt:', error);
    return c.json({ success: false, message: 'Gagal membuat pesan WhatsApp struk', error: error.message }, 500);
  }
});

export default router;
