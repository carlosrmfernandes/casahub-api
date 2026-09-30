import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { monthStr } from '../lib/http';
import { ensureMonth } from '../lib/bills';
import { getInvoices } from '../lib/cards';
import { currentMonth, dueDateFor, monthBounds, toISODate, todayISO } from '../lib/month';
import { incomesForMonth } from './incomes';

type CalendarItem = {
  date: string;
  type: 'event' | 'bill' | 'invoice' | 'task' | 'income';
  id: string;
  title: string;
  time?: string | null;
  amountCents?: number;
  status?: string;
  overdue?: boolean;
  color?: string | null;
};

/** Tudo que acontece no mês, num lugar só: compromissos, contas, faturas, tarefas e entradas. */
export const calendarRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { month } = z.object({ month: monthStr.default(currentMonth()) }).parse(req.query);
    const hid = req.user.hid;
    const today = todayISO();
    const range = monthBounds(month);
    await ensureMonth(hid, month);

    const [events, bills, invoices, tasks, incomes] = await Promise.all([
      prisma.event.findMany({ where: { householdId: hid, date: range }, include: { member: { select: { color: true } } } }),
      prisma.bill.findMany({ where: { householdId: hid, month, status: { not: 'IGNORADA' } } }),
      getInvoices(hid, month),
      prisma.task.findMany({ where: { householdId: hid, done: false, dueDate: range }, include: { assignee: { select: { color: true } } } }),
      incomesForMonth(hid, month),
    ]);

    const items: CalendarItem[] = [
      ...events.map((e) => ({
        date: toISODate(e.date),
        type: 'event' as const,
        id: e.id,
        title: e.title,
        time: e.time,
        color: e.member?.color,
      })),
      ...bills.map((b) => {
        const date = toISODate(b.dueDate);
        return {
          date,
          type: 'bill' as const,
          id: b.id,
          title: b.name,
          amountCents: b.amountCents,
          status: b.status,
          overdue: b.status === 'PENDENTE' && date < today,
        };
      }),
      ...invoices
        .filter((i) => i.totalCents > 0)
        .map((i) => ({
          date: i.dueDate,
          type: 'invoice' as const,
          id: i.cardId,
          title: `Fatura ${i.cardName}`,
          amountCents: i.totalCents,
          status: i.status,
          overdue: i.status === 'PENDENTE' && i.dueDate < today,
          color: i.color,
        })),
      ...tasks.map((t) => ({
        date: toISODate(t.dueDate!),
        type: 'task' as const,
        id: t.id,
        title: t.title,
        color: t.assignee?.color,
        overdue: toISODate(t.dueDate!) < today,
      })),
      ...incomes
        .filter((i) => i.day)
        .map((i) => ({
          date: toISODate(dueDateFor(month, i.day!)),
          type: 'income' as const,
          id: i.id,
          title: i.name,
          amountCents: i.amountCents,
        })),
    ];

    const order = { income: 0, bill: 1, invoice: 2, event: 3, task: 4 };
    items.sort((a, b) => a.date.localeCompare(b.date) || order[a.type] - order[b.type] || (a.time ?? '').localeCompare(b.time ?? ''));
    return { month, today, items };
  });
};
