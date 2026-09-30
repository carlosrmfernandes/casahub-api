import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { ZodError } from 'zod';
import { authPublicRoutes, authPrivateRoutes } from './routes/auth';
import { memberRoutes } from './routes/members';
import { recurringBillRoutes } from './routes/recurringBills';
import { billRoutes } from './routes/bills';
import { cardRoutes } from './routes/cards';
import { incomeRoutes } from './routes/incomes';
import { reserveRoutes } from './routes/reserves';
import { dashboardRoutes } from './routes/dashboard';
import { taskRoutes } from './routes/tasks';
import { shoppingRoutes } from './routes/shopping';
import { eventRoutes } from './routes/events';
import { calendarRoutes } from './routes/calendar';

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  const origins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: origins.length ? origins : true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET não configurado');
  await app.register(jwt, { secret });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: err.issues[0]?.message ?? 'Dados inválidos',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    const isJwtError = String((err as { code?: string }).code ?? '').startsWith('FST_JWT_');
    const message = isJwtError ? 'Sessão expirada, entre novamente' : status >= 500 ? 'Erro interno' : (err as Error).message;
    return reply.code(status).send({ error: message });
  });

  app.get('/health', async () => ({ ok: true }));

  await app.register(authPublicRoutes, { prefix: '/auth' });

  await app.register(async (priv) => {
    priv.addHook('onRequest', async (req) => {
      await req.jwtVerify();
    });
    await priv.register(authPrivateRoutes, { prefix: '/auth' });
    await priv.register(memberRoutes, { prefix: '/members' });
    await priv.register(recurringBillRoutes, { prefix: '/recurring-bills' });
    await priv.register(billRoutes, { prefix: '/bills' });
    await priv.register(cardRoutes, { prefix: '/cards' });
    await priv.register(incomeRoutes, { prefix: '/incomes' });
    await priv.register(reserveRoutes, { prefix: '/reserves' });
    await priv.register(dashboardRoutes, { prefix: '/dashboard' });
    await priv.register(taskRoutes, { prefix: '/tasks' });
    await priv.register(shoppingRoutes, { prefix: '/shopping' });
    await priv.register(eventRoutes, { prefix: '/events' });
    await priv.register(calendarRoutes, { prefix: '/calendar' });
  });

  return app;
}
