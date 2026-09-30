import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Reserve, ReserveMovement } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError, cents, dateStr, idParams, notFound, optionalText } from '../lib/http';
import { toDate, toISODate, todayISO } from '../lib/month';

const reserveBody = z.object({
  name: z.string().trim().min(1, 'Informe o nome da reserva'),
  goalCents: cents.nullish(),
});

const movementBody = z.object({
  type: z.enum(['DEPOSITO', 'RETIRADA']),
  amountCents: cents.min(1, 'Informe o valor'),
  date: dateStr.optional(),
  note: optionalText,
});

const balance = (movements: ReserveMovement[]) =>
  movements.reduce((s, m) => s + (m.type === 'DEPOSITO' ? m.amountCents : -m.amountCents), 0);

function serialize(r: Reserve & { movements: ReserveMovement[] }) {
  return {
    id: r.id,
    name: r.name,
    goalCents: r.goalCents,
    balanceCents: balance(r.movements),
    movements: r.movements.map((m) => ({ ...m, date: toISODate(m.date) })),
  };
}

const include = { movements: { orderBy: [{ date: 'desc' as const }, { createdAt: 'desc' as const }] } };

export const reserveRoutes: FastifyPluginAsync = async (app) => {
  async function find(hid: string, id: string) {
    const r = await prisma.reserve.findFirst({ where: { id, householdId: hid }, include });
    if (!r) throw notFound('Reserva');
    return r;
  }

  app.get('/', async (req) => {
    const list = await prisma.reserve.findMany({ where: { householdId: req.user.hid }, orderBy: { createdAt: 'asc' }, include });
    return list.map(serialize);
  });

  app.post('/', async (req) => {
    const body = reserveBody.parse(req.body);
    const r = await prisma.reserve.create({ data: { ...body, householdId: req.user.hid }, include });
    return serialize(r);
  });

  app.patch('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = reserveBody.partial().parse(req.body);
    await find(req.user.hid, id);
    const r = await prisma.reserve.update({ where: { id }, data: body, include });
    return serialize(r);
  });

  app.delete('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    await find(req.user.hid, id);
    await prisma.reserve.delete({ where: { id } });
    return { ok: true };
  });

  app.post('/:id/movements', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = movementBody.parse(req.body);
    const r = await find(req.user.hid, id);
    if (body.type === 'RETIRADA' && body.amountCents > balance(r.movements)) {
      throw new HttpError(400, 'A retirada é maior que o saldo da reserva');
    }
    await prisma.reserveMovement.create({
      data: { reserveId: id, type: body.type, amountCents: body.amountCents, note: body.note, date: toDate(body.date ?? todayISO()) },
    });
    return serialize(await find(req.user.hid, id));
  });

  app.delete('/:id/movements/:movementId', async (req) => {
    const { id, movementId } = z.object({ id: z.string().min(1), movementId: z.string().min(1) }).parse(req.params);
    await find(req.user.hid, id);
    const { count } = await prisma.reserveMovement.deleteMany({ where: { id: movementId, reserveId: id } });
    if (!count) throw notFound('Movimentação');
    return serialize(await find(req.user.hid, id));
  });
};
