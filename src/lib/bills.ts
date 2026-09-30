import { prisma } from './prisma';
import { dueDateFor } from './month';

/**
 * Gera os lançamentos do mês a partir das contas fixas ativas que ainda não têm lançamento.
 * Contas de valor variável usam o último valor pago/lançado como estimativa.
 */
export async function ensureMonth(householdId: string, month: string) {
  const recurring = await prisma.recurringBill.findMany({
    where: {
      householdId,
      active: true,
      startMonth: { lte: month },
      OR: [{ endMonth: null }, { endMonth: { gte: month } }],
    },
  });
  if (recurring.length === 0) return;

  const existing = await prisma.bill.findMany({
    where: { month, recurringBillId: { in: recurring.map((r) => r.id) } },
    select: { recurringBillId: true },
  });
  const has = new Set(existing.map((b) => b.recurringBillId));
  const missing = recurring.filter((r) => !has.has(r.id));
  if (missing.length === 0) return;

  const data = await Promise.all(
    missing.map(async (r) => {
      let amountCents = r.amountCents;
      if (r.variable) {
        const last = await prisma.bill.findFirst({
          where: { recurringBillId: r.id, month: { lt: month }, status: { not: 'IGNORADA' } },
          orderBy: { month: 'desc' },
          select: { amountCents: true },
        });
        if (last && last.amountCents > 0) amountCents = last.amountCents;
      }
      return {
        householdId,
        recurringBillId: r.id,
        month,
        name: r.name,
        category: r.category,
        amountCents,
        estimated: r.variable,
        dueDate: dueDateFor(month, r.dueDay),
        method: r.method,
        responsibleId: r.responsibleId,
      };
    }),
  );

  await prisma.bill.createMany({ data, skipDuplicates: true });
}
