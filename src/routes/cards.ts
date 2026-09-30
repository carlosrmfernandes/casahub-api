import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { HttpError, assertMember, category, cents, dateStr, idParams, monthStr, notFound } from '../lib/http';
import { getInvoices, invoiceMonthFor } from '../lib/cards';
import { addMonths, currentMonth, toDate, toISODate, todayISO } from '../lib/month';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const cardBody = z.object({
  name: z.string().trim().min(1, 'Informe o nome do cartão'),
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  limitCents: cents.nullish(),
  color: color.optional(),
});

const purchaseBody = z.object({
  description: z.string().trim().min(1, 'Informe a descrição'),
  category: category.default('OUTROS'),
  totalCents: cents.min(1, 'Informe o valor'),
  installments: z.number().int().min(1).max(48).default(1),
  recurring: z.boolean().default(false),
  purchaseDate: dateStr.optional(),
  /** Força a fatura da primeira parcela (se não informado, calcula pelo fechamento). */
  firstInvoiceMonth: monthStr.optional(),
  responsibleId: z.string().nullish(),
});

const invoiceParams = z.object({ id: z.string().min(1), month: monthStr });
const purchaseParams = z.object({ purchaseId: z.string().min(1) });

export const cardRoutes: FastifyPluginAsync = async (app) => {
  async function findCard(hid: string, id: string) {
    const card = await prisma.creditCard.findFirst({ where: { id, householdId: hid } });
    if (!card) throw notFound('Cartão');
    return card;
  }

  async function findPurchase(hid: string, purchaseId: string) {
    const p = await prisma.cardPurchase.findFirst({ where: { id: purchaseId, card: { householdId: hid } }, include: { card: true } });
    if (!p) throw notFound('Compra');
    return p;
  }

  app.get('/', async (req) => {
    return prisma.creditCard.findMany({ where: { householdId: req.user.hid }, orderBy: { createdAt: 'asc' } });
  });

  app.post('/', async (req) => {
    const body = cardBody.parse(req.body);
    return prisma.creditCard.create({ data: { ...body, householdId: req.user.hid } });
  });

  app.patch('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = cardBody.partial().parse(req.body);
    await findCard(req.user.hid, id);
    return prisma.creditCard.update({ where: { id }, data: body });
  });

  app.delete('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    await findCard(req.user.hid, id);
    await prisma.creditCard.delete({ where: { id } });
    return { ok: true };
  });

  /** Faturas do mês de todos os cartões. */
  app.get('/invoices', async (req) => {
    const { month } = z.object({ month: monthStr.default(currentMonth()) }).parse(req.query);
    return getInvoices(req.user.hid, month);
  });

  app.get('/:id/invoices/:month', async (req) => {
    const { id, month } = invoiceParams.parse(req.params);
    await findCard(req.user.hid, id);
    const [invoice] = await getInvoices(req.user.hid, month, id);
    return invoice;
  });

  app.post('/:id/invoices/:month/pay', async (req) => {
    const { id, month } = invoiceParams.parse(req.params);
    const body = z.object({ paidAt: dateStr.optional(), amountCents: cents.optional() }).default({}).parse(req.body ?? {});
    await findCard(req.user.hid, id);
    const data = {
      status: 'PAGO' as const,
      paidAt: toDate(body.paidAt ?? todayISO()),
      ...(body.amountCents !== undefined ? { overrideCents: body.amountCents } : {}),
    };
    await prisma.cardInvoice.upsert({ where: { cardId_month: { cardId: id, month } }, create: { cardId: id, month, ...data }, update: data });
    const [invoice] = await getInvoices(req.user.hid, month, id);
    return invoice;
  });

  app.post('/:id/invoices/:month/unpay', async (req) => {
    const { id, month } = invoiceParams.parse(req.params);
    await findCard(req.user.hid, id);
    await prisma.cardInvoice.updateMany({ where: { cardId: id, month }, data: { status: 'PENDENTE', paidAt: null } });
    const [invoice] = await getInvoices(req.user.hid, month, id);
    return invoice;
  });

  /** Valor real da fatura, quando diferente do calculado pelas compras. null volta ao calculado. */
  app.put('/:id/invoices/:month/amount', async (req) => {
    const { id, month } = invoiceParams.parse(req.params);
    const { amountCents } = z.object({ amountCents: cents.nullable() }).parse(req.body);
    await findCard(req.user.hid, id);
    await prisma.cardInvoice.upsert({
      where: { cardId_month: { cardId: id, month } },
      create: { cardId: id, month, overrideCents: amountCents },
      update: { overrideCents: amountCents },
    });
    const [invoice] = await getInvoices(req.user.hid, month, id);
    return invoice;
  });

  app.post('/:id/purchases', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = purchaseBody.parse(req.body);
    const card = await findCard(req.user.hid, id);
    await assertMember(req.user.hid, body.responsibleId);
    const purchaseDate = body.purchaseDate ?? todayISO();
    const first = body.firstInvoiceMonth ?? invoiceMonthFor(purchaseDate, card.closingDay, card.dueDay);
    const installments = body.recurring ? 1 : body.installments;
    const p = await prisma.cardPurchase.create({
      data: {
        cardId: id,
        description: body.description,
        category: body.category,
        totalCents: body.totalCents,
        installments,
        recurring: body.recurring,
        purchaseDate: toDate(purchaseDate),
        firstInvoiceMonth: first,
        lastInvoiceMonth: body.recurring ? null : addMonths(first, installments - 1),
        responsibleId: body.responsibleId ?? null,
      },
    });
    return { ...p, purchaseDate: toISODate(p.purchaseDate) };
  });

  app.patch('/purchases/:purchaseId', async (req) => {
    const { purchaseId } = purchaseParams.parse(req.params);
    const body = purchaseBody.partial().parse(req.body);
    const existing = await findPurchase(req.user.hid, purchaseId);
    await assertMember(req.user.hid, body.responsibleId);
    const recurring = body.recurring ?? existing.recurring;
    const installments = recurring ? 1 : (body.installments ?? existing.installments);
    const purchaseDate = body.purchaseDate ?? toISODate(existing.purchaseDate);
    const first =
      body.firstInvoiceMonth ??
      (body.purchaseDate ? invoiceMonthFor(purchaseDate, existing.card.closingDay, existing.card.dueDay) : existing.firstInvoiceMonth);
    const p = await prisma.cardPurchase.update({
      where: { id: purchaseId },
      data: {
        description: body.description,
        category: body.category,
        totalCents: body.totalCents,
        responsibleId: body.responsibleId,
        installments,
        recurring,
        purchaseDate: toDate(purchaseDate),
        firstInvoiceMonth: first,
        lastInvoiceMonth: recurring ? (body.recurring === undefined ? existing.lastInvoiceMonth : null) : addMonths(first, installments - 1),
      },
    });
    return { ...p, purchaseDate: toISODate(p.purchaseDate) };
  });

  /** Encerra uma assinatura: a última cobrança é na fatura do mês informado. */
  app.post('/purchases/:purchaseId/stop', async (req) => {
    const { purchaseId } = purchaseParams.parse(req.params);
    const { lastMonth } = z.object({ lastMonth: monthStr }).parse(req.body);
    const existing = await findPurchase(req.user.hid, purchaseId);
    if (!existing.recurring) throw new HttpError(400, 'Só assinaturas podem ser encerradas');
    if (lastMonth < existing.firstInvoiceMonth) {
      await prisma.cardPurchase.delete({ where: { id: purchaseId } });
      return { ok: true, deleted: true };
    }
    await prisma.cardPurchase.update({ where: { id: purchaseId }, data: { lastInvoiceMonth: lastMonth } });
    return { ok: true, deleted: false };
  });

  app.delete('/purchases/:purchaseId', async (req) => {
    const { purchaseId } = purchaseParams.parse(req.params);
    await findPurchase(req.user.hid, purchaseId);
    await prisma.cardPurchase.delete({ where: { id: purchaseId } });
    return { ok: true };
  });
};
