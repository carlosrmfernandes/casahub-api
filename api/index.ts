import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

// Função da Vercel: a mesma API do servidor local, criada uma vez por instância.
let ready: Promise<FastifyInstance> | null = null;

function start() {
  ready ??= buildApp().then(async (app) => {
    await app.ready();
    return app;
  });
  // Se falhar (ex: variável de ambiente faltando), tenta de novo na próxima chamada.
  ready.catch(() => {
    ready = null;
  });
  return ready;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  let app: FastifyInstance;
  try {
    app = await start();
  } catch (err) {
    console.error('Falha ao iniciar a API', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('access-control-allow-origin', '*');
    res.end(JSON.stringify({ error: 'A API não conseguiu iniciar', detail: (err as Error).message }));
    return;
  }
  app.server.emit('request', req, res);
}
