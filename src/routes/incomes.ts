import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Income } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError, cents, idParams, monthStr, notFound } from '../lib/http';
import { currentMonth } from '../lib/month';

const incomeBody = z.object({
  name: z.string().trim().min(1, 'Informe de onde vem o dinheiro'),
  amountCents: cents,
  day: z.number().int().min(1).max(31).nullish(),
  recurring: z.boolean().default(true),
  startMonth: monthStr.optional(),
  endMonth: monthStr.nullish(),
});

/** Entradas que valem no mês. Avulsa vale só no mês inicial. */
export function incomeInMonth(i: Income, month: string) {
  if (!i.recurring) return i.startMonth === month;
  return i.startMonth <= month && (!i.endMonth || i.endMonth >= month);
}

export async function incomesForMonth(householdId: string, month: string) {
  const all = await prisma.income.findMany({ where: { householdId, startMonth: { lte: month } }, orderBy: { createdAt: 'asc' } });
  return all.filter((i) => incomeInMonth(i, month));
}

export const incomeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { month } = z.object({ month: monthStr.optional() }).parse(req.query);
    if (month) return incomesForMonth(req.user.hid, month);
    return prisma.income.findMany({ where: { householdId: req.user.hid }, orderBy: { createdAt: 'asc' } });
  });

  app.post('/', async (req) => {
    const body = incomeBody.parse(req.body);
    const startMonth = body.startMonth ?? currentMonth();
    if (body.endMonth && body.endMonth < startMonth) throw new HttpError(400, 'O mês final não pode ser antes do mês inicial');
    return prisma.income.create({
      data: { ...body, startMonth, endMonth: body.recurring ? (body.endMonth ?? null) : null, householdId: req.user.hid },
    });
  });

  app.patch('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = incomeBody.partial().parse(req.body);
    const existing = await prisma.income.findFirst({ where: { id, householdId: req.user.hid } });
    if (!existing) throw notFound('Entrada');
    const startMonth = body.startMonth ?? existing.startMonth;
    const endMonth = body.endMonth === undefined ? existing.endMonth : body.endMonth;
    if (endMonth && endMonth < startMonth) throw new HttpError(400, 'O mês final não pode ser antes do mês inicial');
    return prisma.income.update({ where: { id }, data: { ...body, startMonth, endMonth } });
  });

  app.delete('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const { count } = await prisma.income.deleteMany({ where: { id, householdId: req.user.hid } });
    if (!count) throw notFound('Entrada');
    return { ok: true };
  });
};
