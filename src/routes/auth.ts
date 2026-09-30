import type { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { User } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http';

export const publicUser = (u: User) => ({ id: u.id, name: u.name, email: u.email, role: u.role, color: u.color });

const registerBody = z.object({
  name: z.string().trim().min(1, 'Informe seu nome'),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  password: z.string().min(6, 'A senha precisa ter pelo menos 6 caracteres'),
  householdName: z.string().trim().min(1).default('Minha Casa'),
});

const loginBody = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string(),
});

export const authPublicRoutes: FastifyPluginAsync = async (app) => {
  app.post('/register', async (req) => {
    const body = registerBody.parse(req.body);
    if (await prisma.user.findUnique({ where: { email: body.email } })) {
      throw new HttpError(409, 'Este e-mail já está cadastrado');
    }
    const household = await prisma.household.create({
      data: {
        name: body.householdName,
        users: {
          create: {
            name: body.name,
            email: body.email,
            passwordHash: await bcrypt.hash(body.password, 10),
            role: 'ADMIN',
          },
        },
      },
      include: { users: true },
    });
    const user = household.users[0];
    const token = app.jwt.sign({ sub: user.id, hid: household.id }, { expiresIn: '30d' });
    return { token, user: publicUser(user), household: { id: household.id, name: household.name } };
  });

  app.post('/login', async (req) => {
    const body = loginBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email }, include: { household: true } });
    if (!user?.passwordHash || !(await bcrypt.compare(body.password, user.passwordHash))) {
      throw new HttpError(401, 'E-mail ou senha incorretos');
    }
    const token = app.jwt.sign({ sub: user.id, hid: user.householdId }, { expiresIn: '30d' });
    return { token, user: publicUser(user), household: { id: user.household.id, name: user.household.name } };
  });
};

export const authPrivateRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (req) => {
    const user = await prisma.user.findFirst({ where: { id: req.user.sub }, include: { household: true } });
    if (!user) throw new HttpError(401, 'Usuário não encontrado');
    return { user: publicUser(user), household: { id: user.household.id, name: user.household.name } };
  });

  app.patch('/household', async (req) => {
    const body = z.object({ name: z.string().trim().min(1) }).parse(req.body);
    const h = await prisma.household.update({ where: { id: req.user.hid }, data: { name: body.name } });
    return { id: h.id, name: h.name };
  });

  app.post('/password', async (req) => {
    const body = z.object({ current: z.string(), next: z.string().min(6, 'A senha precisa ter pelo menos 6 caracteres') }).parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (!user.passwordHash || !(await bcrypt.compare(body.current, user.passwordHash))) {
      throw new HttpError(400, 'Senha atual incorreta');
    }
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(body.next, 10) } });
    return { ok: true };
  });
};
