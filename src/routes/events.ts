import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Event } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertMember, dateStr, idParams, monthStr, notFound, optionalText } from '../lib/http';
import { currentMonth, monthBounds, toDate, toISODate } from '../lib/month';

const eventBody = z.object({
  title: z.string().trim().min(1, 'Informe o compromisso'),
  date: dateStr,
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Hora no formato HH:MM').nullish(),
  notes: optionalText,
  memberId: z.string().nullish(),
});

const include = { member: { select: { id: true, name: true, color: true } } } as const;

export const serializeEvent = (e: Event & { member?: { id: string; name: string; color: string } | null }) => ({
  ...e,
  date: toISODate(e.date),
});

export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { month } = z.object({ month: monthStr.default(currentMonth()) }).parse(req.query);
    const events = await prisma.event.findMany({
      where: { householdId: req.user.hid, date: monthBounds(month) },
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
      include,
    });
    return events.map(serializeEvent);
  });

  app.post('/', async (req) => {
    const body = eventBody.parse(req.body);
    await assertMember(req.user.hid, body.memberId);
    const e = await prisma.event.create({ data: { ...body, date: toDate(body.date), householdId: req.user.hid }, include });
    return serializeEvent(e);
  });

  app.patch('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = eventBody.partial().parse(req.body);
    const existing = await prisma.event.findFirst({ where: { id, householdId: req.user.hid } });
    if (!existing) throw notFound('Compromisso');
    await assertMember(req.user.hid, body.memberId);
    const e = await prisma.event.update({
      where: { id },
      data: { ...body, date: body.date ? toDate(body.date) : undefined },
      include,
    });
    return serializeEvent(e);
  });

  app.delete('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const { count } = await prisma.event.deleteMany({ where: { id, householdId: req.user.hid } });
    if (!count) throw notFound('Compromisso');
    return { ok: true };
  });
};
