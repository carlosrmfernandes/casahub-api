import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { idParams, notFound } from '../lib/http';

const itemBody = z.object({
  name: z.string().trim().min(1, 'Informe o item'),
  quantity: z.string().trim().max(50).nullish(),
  checked: z.boolean().optional(),
});

export const shoppingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    return prisma.shoppingItem.findMany({
      where: { householdId: req.user.hid },
      orderBy: [{ checked: 'asc' }, { createdAt: 'desc' }],
    });
  });

  app.post('/', async (req) => {
    const body = itemBody.parse(req.body);
    return prisma.shoppingItem.create({ data: { ...body, householdId: req.user.hid } });
  });

  app.patch('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = itemBody.partial().parse(req.body);
    const existing = await prisma.shoppingItem.findFirst({ where: { id, householdId: req.user.hid } });
    if (!existing) throw notFound('Item');
    return prisma.shoppingItem.update({ where: { id }, data: body });
  });

  /** Limpa os itens já comprados. */
  app.post('/clear-checked', async (req) => {
    const { count } = await prisma.shoppingItem.deleteMany({ where: { householdId: req.user.hid, checked: true } });
    return { count };
  });

  app.delete('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const { count } = await prisma.shoppingItem.deleteMany({ where: { id, householdId: req.user.hid } });
    if (!count) throw notFound('Item');
    return { ok: true };
  });
};
