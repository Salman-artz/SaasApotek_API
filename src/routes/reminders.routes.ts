import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';
import { db } from '../db/index';
import { chronicReminders, customers, tenants } from '../db/schema/index';
import { eq, and, desc, lte } from 'drizzle-orm';

const router = new Hono();
router.use('*', authMiddleware, tenantMiddleware);

// 1. LIST CHRONIC PATIENT REMINDERS
router.get('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const filter = query.filter?.trim(); // 'upcoming' | 'sent' | 'all'

    const conditions = [eq(chronicReminders.tenantId, tenantId)];

    if (filter === 'upcoming') {
      conditions.push(eq(chronicReminders.status, 'PENDING'));
    } else if (filter === 'sent') {
      conditions.push(eq(chronicReminders.status, 'SENT'));
    }

    const rows = await db
      .select()
      .from(chronicReminders)
      .where(and(...conditions))
      .orderBy(chronicReminders.reminderDate, desc(chronicReminders.createdAt));

    return c.json({ success: true, data: rows });
  } catch (error: any) {
    return c.json({ success: false, message: 'Gagal memuat pengingat obat', error: error.message }, 500);
  }
});

// 2. CREATE CHRONIC PATIENT REMINDER
const reminderSchema = z.object({
  customerId: z.string().uuid().optional(),
  customerName: z.string().min(2),
  customerPhone: z.string().min(8),
  drugName: z.string().min(2),
  signa: z.string().optional().default('1 x 1 sehari sesudah makan'),
  lastDispenseDate: z.string(),
  daysSupply: z.number().min(1).default(30),
  notes: z.string().optional(),
});

router.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const validated = reminderSchema.parse(body);

    const lastDate = new Date(validated.lastDispenseDate);
    const finishDate = new Date(lastDate.getTime() + validated.daysSupply * 24 * 60 * 60 * 1000);
    const reminderDate = new Date(finishDate.getTime() - 3 * 24 * 60 * 60 * 1000); // H-3

    const [newReminder] = await db
      .insert(chronicReminders)
      .values({
        tenantId,
        customerId: validated.customerId || null,
        customerName: validated.customerName,
        customerPhone: validated.customerPhone,
        drugName: validated.drugName,
        signa: validated.signa,
        lastDispenseDate: validated.lastDispenseDate,
        estimatedFinishDate: finishDate.toISOString().split('T')[0],
        reminderDate: reminderDate.toISOString().split('T')[0],
        status: 'PENDING',
        notes: validated.notes,
      })
      .returning();

    return c.json({
      success: true,
      message: 'Jadwal pengingat obat kronis berhasil dibuat',
      data: newReminder,
    }, 201);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, message: error.errors[0].message }, 400);
    }
    return c.json({ success: false, message: 'Gagal membuat pengingat', error: error.message }, 500);
  }
});

// 3. SEND REMINDER / GENERATE WHATSAPP MESSAGE
router.post('/:id/send', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const id = c.req.param('id');

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    const [reminder] = await db
      .select()
      .from(chronicReminders)
      .where(and(eq(chronicReminders.id, id), eq(chronicReminders.tenantId, tenantId)));

    if (!reminder) {
      return c.json({ success: false, message: 'Pengingat tidak ditemukan' }, 404);
    }

    let phone = reminder.customerPhone.replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '62' + phone.slice(1);
    else if (phone.startsWith('8')) phone = '62' + phone;

    const message = `Halo Bapak/Ibu *${reminder.customerName}*,\n\n` +
      `Salam hangat dari *${tenant?.name || 'Apotek Digital'}* 🏥\n\n` +
      `Berdasarkan catatan rekam medis farmasi kami, persediaan obat rutin Anda: *${reminder.drugName}* diperkirakan akan habis dalam 3 hari ke depan (sekitar tanggal *${reminder.estimatedFinishDate}*).\n\n` +
      `Untuk menjaga kesinambungan terapi kesehatan Anda, silakan hubungi apotek kami untuk konsultasi, perpanjangan resep dokter, atau pengantaran obat ke rumah.\n\n` +
      `Semoga selalu sehat walafiat! 🙏\n_Apoteker Penanggung Jawab_`;

    const waLink = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;

    // Update status to SENT
    await db
      .update(chronicReminders)
      .set({ status: 'SENT', sentAt: new Date() })
      .where(eq(chronicReminders.id, id));

    return c.json({
      success: true,
      message: 'Pesan pengingat berhasil disiapkan',
      data: {
        waLink,
        message,
        phone,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, message: 'Gagal mengirim pengingat', error: error.message }, 500);
  }
});

export default router;
