import { z } from 'zod';
import { Category, PaymentMethod } from '@prisma/client';
import { prisma } from './prisma';
import { DATE_RE, MONTH_RE } from './month';

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Registro') => new HttpError(404, `${what} não encontrado`);

export const idParams = z.object({ id: z.string().min(1) });
export const monthStr = z.string().regex(MONTH_RE, 'Mês deve estar no formato AAAA-MM');
export const dateStr = z.string().regex(DATE_RE, 'Data deve estar no formato AAAA-MM-DD');
export const cents = z.number().int().min(0);
export const category = z.enum(Category);
export const paymentMethod = z.enum(PaymentMethod);
export const optionalText = z.string().trim().max(500).nullish();

/** Garante que o membro (se informado) pertence à mesma casa. */
export async function assertMember(householdId: string, userId: string | null | undefined) {
  if (!userId) return;
  const found = await prisma.user.findFirst({ where: { id: userId, householdId }, select: { id: true } });
  if (!found) throw new HttpError(400, 'Membro inválido');
}
