import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/app';

// Função da Vercel: a mesma API do servidor local, criada uma vez por instância.
const ready = buildApp().then(async (app) => {
  await app.ready();
  return app;
});

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await ready;
  app.server.emit('request', req, res);
}
