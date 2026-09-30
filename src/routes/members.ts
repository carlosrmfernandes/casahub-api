import type { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { HttpError, idParams, notFound } from '../lib/http';
import { publicUser } from './auth';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const memberBody = z.object({
  name: z.string().trim().min(1, 'Informe o nome'),
  email: z.string().trim().toLowerCase().email('E-mail inválido').nullish(),
  password: z.string().min(6, 'A senha precisa ter pelo menos 6 caracteres').nullish(),
  color: color.optional(),
  role: z.enum(['ADMIN', 'MEMBER']).optional(),
});

export const memberRoutes: FastifyPluginAsync = async (app) => {
  async function requireAdmin(userId: string) {
    const me = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (me.role !== 'ADMIN') throw new HttpError(403, 'Apenas administradores podem gerenciar a família');
  }

  app.get('/', async (req) => {
    const users = await prisma.user.findMany({ where: { householdId: req.user.hid }, orderBy: { createdAt: 'asc' } });
    return users.map((u) => ({ ...publicUser(u), hasLogin: !!u.passwordHash }));
  });

  app.post('/', async (req) => {
    await requireAdmin(req.user.sub);
    const body = memberBody.parse(req.body);
    if (body.email && !body.password) throw new HttpError(400, 'Informe uma senha para o acesso');
    if (body.email && (await prisma.user.findUnique({ where: { email: body.email } }))) {
      throw new HttpError(409, 'Este e-mail já está cadastrado');
    }
    const user = await prisma.user.create({
      data: {
        householdId: req.user.hid,
        name: body.name,
        email: body.email || null,
        passwordHash: body.email && body.password ? await bcrypt.hash(body.password, 10) : null,
        color: body.color,
        role: body.role ?? 'MEMBER',
      },
    });
    return { ...publicUser(user), hasLogin: !!user.passwordHash };
  });

  app.patch('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    if (id !== req.user.sub) await requireAdmin(req.user.sub);
    const body = memberBody.partial().parse(req.body);
    const existing = await prisma.user.findFirst({ where: { id, householdId: req.user.hid } });
    if (!existing) throw notFound('Membro');
    if (body.email && body.email !== existing.email && (await prisma.user.findUnique({ where: { email: body.email } }))) {
      throw new HttpError(409, 'Este e-mail já está cadastrado');
    }
    const user = await prisma.user.update({
      where: { id },
      data: {
        name: body.name,
        color: body.color,
        email: body.email === undefined ? undefined : body.email || null,
        role: id === req.user.sub ? undefined : body.role,
        passwordHash: body.password ? await bcrypt.hash(body.password, 10) : undefined,
      },
    });
    return { ...publicUser(user), hasLogin: !!user.passwordHash };
  });

  app.delete('/:id', async (req) => {
    await requireAdmin(req.user.sub);
    const { id } = idParams.parse(req.params);
    if (id === req.user.sub) throw new HttpError(400, 'Você não pode remover a si mesmo');
    const { count } = await prisma.user.deleteMany({ where: { id, householdId: req.user.hid } });
    if (!count) throw notFound('Membro');
    return { ok: true };
  });
};
