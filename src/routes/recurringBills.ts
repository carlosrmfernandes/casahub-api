import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { HttpError, assertMember, category, cents, idParams, monthStr, notFound, optionalText, paymentMethod } from '../lib/http';
import { currentMonth, dueDateFor, toDate, todayISO } from '../lib/month';
import { ensureMonth } from '../lib/bills';

const recurringBody = z.object({
  name: z.string().trim().min(1, 'Informe o nome da conta'),
  category: category.default('OUTROS'),
  amountCents: cents,
  variable: z.boolean().default(false),
  dueDay: z.number().int().min(1).max(31).default(10),
  startMonth: monthStr.optional(),
  endMonth: monthStr.nullish(),
  method: paymentMethod.nullish(),
  responsibleId: z.string().nullish(),
  active: z.boolean().optional(),
  notes: optionalText,
});

const include = { responsible: { select: { id: true, name: true, color: true } } } as const;

function checkRange(start: string, end: string | null | undefined) {
  if (end && end < start) throw new HttpError(400, 'O mês final não pode ser antes do mês inicial');
}

export const recurringBillRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    return prisma.recurringBill.findMany({
      where: { householdId: req.user.hid },
      orderBy: [{ active: 'desc' }, { dueDay: 'asc' }, { name: 'asc' }],
      include,
    });
  });

  app.post('/', async (req) => {
    const body = recurringBody.parse(req.body);
    await assertMember(req.user.hid, body.responsibleId);
    const startMonth = body.startMonth ?? currentMonth();
    checkRange(startMonth, body.endMonth);
    return prisma.recurringBill.create({
      data: { ...body, startMonth, endMonth: body.endMonth ?? null, householdId: req.user.hid },
      include,
    });
  });

  /**
   * Cadastro de várias contas de uma vez (usado no "comece por aqui").
   * paidBeforeToday: quem está começando agora já pagou o que venceu este mês;
   * esses lançamentos nascem como pagos para não aparecerem como atrasados.
   */
  app.post('/bulk', async (req) => {
    const { items, paidBeforeToday } = z
      .object({ items: z.array(recurringBody).min(1).max(100), paidBeforeToday: z.boolean().default(false) })
      .parse(req.body);
    const month = currentMonth();
    for (const b of items) {
      await assertMember(req.user.hid, b.responsibleId);
      checkRange(b.startMonth ?? month, b.endMonth);
    }
    const created = await prisma.$transaction(
      items.map((b) =>
        prisma.recurringBill.create({
          data: { ...b, startMonth: b.startMonth ?? month, endMonth: b.endMonth ?? null, householdId: req.user.hid },
        }),
      ),
    );
    if (paidBeforeToday) {
      await ensureMonth(req.user.hid, month);
      const due = await prisma.bill.findMany({
        where: {
          recurringBillId: { in: created.map((c) => c.id) },
          month,
          dueDate: { lt: toDate(todayISO()) },
          amountCents: { gt: 0 },
        },
        select: { id: true, dueDate: true },
      });
      await prisma.$transaction(
        due.map((b) => prisma.bill.update({ where: { id: b.id }, data: { status: 'PAGO', paidAt: b.dueDate } })),
      );
    }
    return { count: created.length };
  });

  /**
   * Edita a conta fixa. Os lançamentos pendentes do mês atual em diante
   * são atualizados junto; o histórico já pago fica como está.
   */
  app.patch('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = recurringBody.partial().parse(req.body);
    const existing = await prisma.recurringBill.findFirst({ where: { id, householdId: req.user.hid } });
    if (!existing) throw notFound('Conta');
    await assertMember(req.user.hid, body.responsibleId);
    const startMonth = body.startMonth ?? existing.startMonth;
    const endMonth = body.endMonth === undefined ? existing.endMonth : body.endMonth;
    checkRange(startMonth, endMonth);

    const updated = await prisma.recurringBill.update({
      where: { id },
      data: { ...body, startMonth, endMonth },
      include,
    });

    const from = currentMonth();
    const pending = await prisma.bill.findMany({
      where: { recurringBillId: id, status: 'PENDENTE', month: { gte: from } },
    });
    const outOfRange = pending.filter((b) => !updated.active || b.month < startMonth || (endMonth && b.month > endMonth));
    const keep = pending.filter((b) => !outOfRange.includes(b));

    await prisma.$transaction([
      prisma.bill.deleteMany({ where: { id: { in: outOfRange.map((b) => b.id) } } }),
      ...keep.map((b) =>
        prisma.bill.update({
          where: { id: b.id },
          data: {
            name: updated.name,
            category: updated.category,
            method: updated.method,
            responsibleId: updated.responsibleId,
            dueDate: dueDateFor(b.month, updated.dueDay),
            ...(body.amountCents !== undefined ? { amountCents: updated.amountCents, estimated: updated.variable } : {}),
          },
        }),
      ),
    ]);
    return updated;
  });

  /** Remove a conta fixa e os lançamentos pendentes futuros. Pagos continuam no histórico. */
  app.delete('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const existing = await prisma.recurringBill.findFirst({ where: { id, householdId: req.user.hid } });
    if (!existing) throw notFound('Conta');
    await prisma.$transaction([
      prisma.bill.deleteMany({ where: { recurringBillId: id, status: { not: 'PAGO' }, month: { gte: currentMonth() } } }),
      prisma.recurringBill.delete({ where: { id } }),
    ]);
    return { ok: true };
  });
};
