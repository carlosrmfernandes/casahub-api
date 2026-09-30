import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Task } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertMember, dateStr, idParams, notFound, optionalText } from '../lib/http';
import { addDays, addMonths, dueDateFor, toDate, toISODate, todayISO } from '../lib/month';

const taskBody = z.object({
  title: z.string().trim().min(1, 'Informe a tarefa'),
  notes: optionalText,
  assigneeId: z.string().nullish(),
  dueDate: dateStr.nullish(),
  recurrence: z.enum(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY']).default('NONE'),
});

const include = { assignee: { select: { id: true, name: true, color: true } } } as const;

export function serializeTask(t: Task & { assignee?: { id: string; name: string; color: string } | null }) {
  const dueDate = t.dueDate ? toISODate(t.dueDate) : null;
  return { ...t, dueDate, overdue: !t.done && !!dueDate && dueDate < todayISO() };
}

function nextDue(iso: string, recurrence: Task['recurrence']): string {
  if (recurrence === 'DAILY') return addDays(iso, 1);
  if (recurrence === 'WEEKLY') return addDays(iso, 7);
  const month = addMonths(iso.slice(0, 7), 1);
  return toISODate(dueDateFor(month, Number(iso.slice(8, 10))));
}

export const taskRoutes: FastifyPluginAsync = async (app) => {
  async function find(hid: string, id: string) {
    const t = await prisma.task.findFirst({ where: { id, householdId: hid } });
    if (!t) throw notFound('Tarefa');
    return t;
  }

  app.get('/', async (req) => {
    const { done } = z.object({ done: z.enum(['true', 'false']).optional() }).parse(req.query);
    const tasks = await prisma.task.findMany({
      where: { householdId: req.user.hid, ...(done ? { done: done === 'true' } : {}) },
      orderBy: [{ done: 'asc' }, { dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      include,
      take: 300,
    });
    return tasks.map(serializeTask);
  });

  app.post('/', async (req) => {
    const body = taskBody.parse(req.body);
    await assertMember(req.user.hid, body.assigneeId);
    const t = await prisma.task.create({
      data: { ...body, dueDate: body.dueDate ? toDate(body.dueDate) : null, householdId: req.user.hid },
      include,
    });
    return serializeTask(t);
  });

  app.patch('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = taskBody.partial().parse(req.body);
    await find(req.user.hid, id);
    await assertMember(req.user.hid, body.assigneeId);
    const t = await prisma.task.update({
      where: { id },
      data: { ...body, dueDate: body.dueDate === undefined ? undefined : body.dueDate ? toDate(body.dueDate) : null },
      include,
    });
    return serializeTask(t);
  });

  /** Marca/desmarca. Tarefa que se repete: ao concluir, pula para a próxima data. */
  app.post('/:id/toggle', async (req) => {
    const { id } = idParams.parse(req.params);
    const t = await find(req.user.hid, id);
    let data;
    if (!t.done && t.recurrence !== 'NONE') {
      const base = t.dueDate ? toISODate(t.dueDate) : todayISO();
      data = { doneAt: new Date(), dueDate: toDate(nextDue(base, t.recurrence)) };
    } else {
      data = { done: !t.done, doneAt: t.done ? null : new Date() };
    }
    return serializeTask(await prisma.task.update({ where: { id }, data, include }));
  });

  app.delete('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    await find(req.user.hid, id);
    await prisma.task.delete({ where: { id } });
    return { ok: true };
  });
};
