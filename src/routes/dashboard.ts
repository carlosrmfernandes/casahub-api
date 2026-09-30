import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Category } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { monthStr } from '../lib/http';
import { ensureMonth } from '../lib/bills';
import { getInvoices } from '../lib/cards';
import { addMonths, currentMonth, toDate, todayISO } from '../lib/month';
import { serializeBill } from './bills';
import { incomesForMonth } from './incomes';

type DueItem = {
  kind: 'bill' | 'invoice';
  id: string;
  name: string;
  amountCents: number;
  dueDate: string;
  estimated: boolean;
  cardId?: string;
  month: string;
};

/** Previsão de gastos e entradas dos próximos meses (sem criar lançamentos). */
async function projection(householdId: string, from: string, months: number) {
  const recurring = await prisma.recurringBill.findMany({ where: { householdId, active: true } });
  const latest = await prisma.bill.findMany({
    where: { householdId, recurringBillId: { in: recurring.map((r) => r.id) }, status: { not: 'IGNORADA' } },
    orderBy: { month: 'desc' },
    distinct: ['recurringBillId'],
    select: { recurringBillId: true, amountCents: true },
  });
  const lastAmount = new Map(latest.map((b) => [b.recurringBillId, b.amountCents]));

  const result = [];
  for (let i = 0; i < months; i++) {
    const month = addMonths(from, i);
    const [bills, invoices, incomes] = await Promise.all([
      prisma.bill.findMany({ where: { householdId, month }, select: { recurringBillId: true, amountCents: true, status: true } }),
      getInvoices(householdId, month),
      incomesForMonth(householdId, month),
    ]);
    const hasBill = new Set(bills.map((b) => b.recurringBillId).filter(Boolean));
    const active = recurring.filter((r) => r.startMonth <= month && (!r.endMonth || r.endMonth >= month));
    const billsCents =
      bills.filter((b) => b.status !== 'IGNORADA').reduce((s, b) => s + b.amountCents, 0) +
      active
        .filter((r) => !hasBill.has(r.id))
        .reduce((s, r) => s + (r.variable ? (lastAmount.get(r.id) ?? r.amountCents) : r.amountCents), 0);
    const cardsCents = invoices.reduce((s, inv) => s + inv.totalCents, 0);
    const incomeCents = incomes.reduce((s, x) => s + x.amountCents, 0);
    result.push({
      month,
      incomeCents,
      billsCents,
      cardsCents,
      expensesCents: billsCents + cardsCents,
      balanceCents: incomeCents - billsCents - cardsCents,
      /** Contas que têm a última parcela neste mês (ex: "Casa SP até dezembro"). */
      ending: active.filter((r) => r.endMonth === month).map((r) => ({ id: r.id, name: r.name, amountCents: r.amountCents })),
    });
  }
  return result;
}

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { month } = z.object({ month: monthStr.default(currentMonth()) }).parse(req.query);
    const hid = req.user.hid;
    const today = todayISO();
    await ensureMonth(hid, month);

    const [billRows, invoices, incomes, reserves, olderOverdue, openTasks, shoppingCount] = await Promise.all([
      prisma.bill.findMany({
        where: { householdId: hid, month, status: { not: 'IGNORADA' } },
        orderBy: { dueDate: 'asc' },
        include: { responsible: { select: { id: true, name: true, color: true } } },
      }),
      getInvoices(hid, month),
      incomesForMonth(hid, month),
      prisma.reserve.findMany({ where: { householdId: hid }, include: { movements: true } }),
      // Contas atrasadas de meses anteriores (não podem ser esquecidas).
      prisma.bill.findMany({
        where: { householdId: hid, status: 'PENDENTE', month: { lt: month }, dueDate: { lt: toDate(today) } },
        orderBy: { dueDate: 'asc' },
      }),
      prisma.task.findMany({
        where: { householdId: hid, done: false, dueDate: { lte: toDate(today) } },
        orderBy: { dueDate: 'asc' },
        include: { assignee: { select: { id: true, name: true, color: true } } },
        take: 10,
      }),
      prisma.shoppingItem.count({ where: { householdId: hid, checked: false } }),
    ]);
    const bills = billRows.map(serializeBill);
    const activeInvoices = invoices.filter((i) => i.totalCents > 0 || i.status === 'PAGO');

    const incomeCents = incomes.reduce((s, i) => s + i.amountCents, 0);
    const billsTotal = bills.reduce((s, b) => s + b.amountCents, 0);
    const billsPaid = bills.filter((b) => b.status === 'PAGO').reduce((s, b) => s + b.amountCents, 0);
    const cardsTotal = activeInvoices.reduce((s, i) => s + i.totalCents, 0);
    const cardsPaid = activeInvoices.filter((i) => i.status === 'PAGO').reduce((s, i) => s + i.totalCents, 0);
    const expensesCents = billsTotal + cardsTotal;
    const paidCents = billsPaid + cardsPaid;

    const pending: DueItem[] = [
      ...bills
        .filter((b) => b.status === 'PENDENTE')
        .map((b) => ({ kind: 'bill' as const, id: b.id, name: b.name, amountCents: b.amountCents, dueDate: b.dueDate, estimated: b.estimated, month: b.month })),
      ...activeInvoices
        .filter((i) => i.status === 'PENDENTE')
        .map((i) => ({
          kind: 'invoice' as const,
          id: `${i.cardId}:${i.month}`,
          cardId: i.cardId,
          name: `Fatura ${i.cardName}`,
          amountCents: i.totalCents,
          dueDate: i.dueDate,
          estimated: false,
          month: i.month,
        })),
    ].sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    const overdue = [
      ...olderOverdue.map((b) => {
        const s = serializeBill(b);
        return { kind: 'bill' as const, id: s.id, name: s.name, amountCents: s.amountCents, dueDate: s.dueDate, estimated: s.estimated, month: s.month };
      }),
      ...pending.filter((p) => p.dueDate < today),
    ];

    const byCategory = new Map<Category, number>();
    for (const b of bills) byCategory.set(b.category, (byCategory.get(b.category) ?? 0) + b.amountCents);
    for (const inv of activeInvoices) {
      for (const item of inv.items) byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + item.amountCents);
    }

    const reservesCents = reserves.reduce(
      (s, r) => s + r.movements.reduce((t, m) => t + (m.type === 'DEPOSITO' ? m.amountCents : -m.amountCents), 0),
      0,
    );

    return {
      month,
      today,
      summary: {
        incomeCents,
        expensesCents,
        paidCents,
        pendingCents: expensesCents - paidCents,
        /** Quanto vai sobrar no fim do mês se tudo for pago. */
        balanceCents: incomeCents - expensesCents,
        /** Quanto sobrou até agora (entradas - o que já foi pago). */
        availableCents: incomeCents - paidCents,
        billsTotal,
        billsPaid,
        cardsTotal,
        cardsPaid,
        reservesCents,
        billsCount: bills.length,
        billsPaidCount: bills.filter((b) => b.status === 'PAGO').length,
        estimatedCount: bills.filter((b) => b.status === 'PENDENTE' && (b.estimated || b.amountCents === 0)).length,
      },
      overdue,
      upcoming: pending.filter((p) => p.dueDate >= today).slice(0, 8),
      byCategory: [...byCategory.entries()]
        .map(([category, amountCents]) => ({ category, amountCents }))
        .filter((c) => c.amountCents > 0)
        .sort((a, b) => b.amountCents - a.amountCents),
      invoices: activeInvoices.map(({ items: _items, ...i }) => i),
      tasks: openTasks.map((t) => ({ id: t.id, title: t.title, dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null, assignee: t.assignee })),
      shoppingCount,
      projection: await projection(hid, month, 6),
    };
  });
};
