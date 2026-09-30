import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Bill } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertMember, category, cents, dateStr, idParams, monthStr, notFound, optionalText, paymentMethod } from '../lib/http';
import { ensureMonth } from '../lib/bills';
import { currentMonth, toDate, toISODate, todayISO } from '../lib/month';

const include = { responsible: { select: { id: true, name: true, color: true } } } as const;

export function serializeBill(b: Bill & { responsible?: { id: string; name: string; color: string } | null }) {
  const dueDate = toISODate(b.dueDate);
  return {
    ...b,
    dueDate,
    paidAt: b.paidAt ? toISODate(b.paidAt) : null,
    overdue: b.status === 'PENDENTE' && dueDate < todayISO(),
  };
}

const billBody = z.object({
  name: z.string().trim().min(1, 'Informe o nome da conta'),
  category: category.default('OUTROS'),
  amountCents: cents,
  dueDate: dateStr,
  method: paymentMethod.nullish(),
  responsibleId: z.string().nullish(),
  notes: optionalText,
  paid: z.boolean().optional(),
});

const payBody = z
  .object({
    paidAt: dateStr.optional(),
    amountCents: cents.optional(),
    method: paymentMethod.nullish(),
  })
  .default({});

export const billRoutes: FastifyPluginAsync = async (app) => {
  async function find(hid: string, id: string) {
    const bill = await prisma.bill.findFirst({ where: { id, householdId: hid } });
    if (!bill) throw notFound('Conta');
    return bill;
  }

  app.get('/', async (req) => {
    const { month } = z.object({ month: monthStr.default(currentMonth()) }).parse(req.query);
    await ensureMonth(req.user.hid, month);
    const bills = await prisma.bill.findMany({
      where: { householdId: req.user.hid, month },
      orderBy: [{ dueDate: 'asc' }, { name: 'asc' }],
      include,
    });
    return bills.map(serializeBill);
  });

  /** Conta avulsa (não se repete). */
  app.post('/', async (req) => {
    const { paid, ...body } = billBody.parse(req.body);
    await assertMember(req.user.hid, body.responsibleId);
    const bill = await prisma.bill.create({
      data: {
        ...body,
        householdId: req.user.hid,
        month: body.dueDate.slice(0, 7),
        dueDate: toDate(body.dueDate),
        status: paid ? 'PAGO' : 'PENDENTE',
        paidAt: paid ? toDate(todayISO()) : null,
      },
      include,
    });
    return serializeBill(bill);
  });

  app.patch('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const { paid: _paid, ...body } = billBody.partial().parse(req.body);
    const existing = await find(req.user.hid, id);
    await assertMember(req.user.hid, body.responsibleId);
    const bill = await prisma.bill.update({
      where: { id },
      data: {
        ...body,
        dueDate: body.dueDate ? toDate(body.dueDate) : undefined,
        // Conta avulsa muda de mês junto com o vencimento; a gerada pela fixa fica no mês dela.
        month: body.dueDate && !existing.recurringBillId ? body.dueDate.slice(0, 7) : undefined,
        estimated: body.amountCents !== undefined ? false : undefined,
      },
      include,
    });
    return serializeBill(bill);
  });

  app.post('/:id/pay', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = payBody.parse(req.body ?? {});
    await find(req.user.hid, id);
    const bill = await prisma.bill.update({
      where: { id },
      data: {
        status: 'PAGO',
        paidAt: toDate(body.paidAt ?? todayISO()),
        ...(body.amountCents !== undefined ? { amountCents: body.amountCents, estimated: false } : {}),
        ...(body.method !== undefined ? { method: body.method } : {}),
      },
      include,
    });
    return serializeBill(bill);
  });

  app.post('/:id/unpay', async (req) => {
    const { id } = idParams.parse(req.params);
    await find(req.user.hid, id);
    const bill = await prisma.bill.update({ where: { id }, data: { status: 'PENDENTE', paidAt: null }, include });
    return serializeBill(bill);
  });

  /** "Não teve esse mês": a conta fixa não conta no total do mês. */
  app.post('/:id/skip', async (req) => {
    const { id } = idParams.parse(req.params);
    await find(req.user.hid, id);
    const bill = await prisma.bill.update({ where: { id }, data: { status: 'IGNORADA', paidAt: null }, include });
    return serializeBill(bill);
  });

  app.delete('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const bill = await find(req.user.hid, id);
    if (bill.recurringBillId) {
      // Se apagasse, seria recriada ao abrir o mês. Então só marca como ignorada.
      await prisma.bill.update({ where: { id }, data: { status: 'IGNORADA', paidAt: null } });
    } else {
      await prisma.bill.delete({ where: { id } });
    }
    return { ok: true };
  });
};
