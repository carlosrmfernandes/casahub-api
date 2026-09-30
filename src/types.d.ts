import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    /** sub = id do usuário, hid = id da casa */
    payload: { sub: string; hid: string };
    user: { sub: string; hid: string };
  }
}
