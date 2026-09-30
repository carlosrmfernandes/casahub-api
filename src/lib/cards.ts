import type { CardPurchase, CreditCard } from '@prisma/client';
import { prisma } from './prisma';
import { addMonths, dueDateFor, monthDiff, toISODate } from './month';

/**
 * Mês da fatura (mês do vencimento) em que cai uma compra.
 * Compras a partir do dia de fechamento vão para o ciclo seguinte.
 */
export function invoiceMonthFor(purchaseDate: string, closingDay: number, dueDay: number): string {
  const month = purchaseDate.slice(0, 7);
  const day = Number(purchaseDate.slice(8, 10));
  let closing = day < closingDay ? month : addMonths(month, 1);
  // Se vence antes (ou no dia) do fechamento, o vencimento é no mês seguinte ao fechamento.
  if (dueDay <= closingDay) closing = addMonths(closing, 1);
  return closing;
}

/** Valor que a compra cobra na fatura do mês (ou null se não cobra). */
export function chargeFor(p: CardPurchase, month: string): { installment: number | null; amountCents: number } | null {
  if (month < p.firstInvoiceMonth) return null;
  if (p.lastInvoiceMonth && month > p.lastInvoiceMonth) return null;
  if (p.recurring) return { installment: null, amountCents: p.totalCents };

  const idx = monthDiff(p.firstInvoiceMonth, month);
  if (idx >= p.installments) return null;
  const base = Math.floor(p.totalCents / p.installments);
  const remainder = p.totalCents - base * p.installments;
  return { installment: idx + 1, amountCents: base + (idx === 0 ? remainder : 0) };
}

export type Invoice = Awaited<ReturnType<typeof getInvoices>>[number];

/** Faturas do mês de todos os cartões da casa (ou de um cartão). */
export async function getInvoices(householdId: string, month: string, cardId?: string) {
  const cards = await prisma.creditCard.findMany({
    where: { householdId, ...(cardId ? { id: cardId } : {}) },
    orderBy: { createdAt: 'asc' },
    include: {
      invoices: { where: { month } },
      purchases: {
        where: {
          firstInvoiceMonth: { lte: month },
          OR: [{ lastInvoiceMonth: null }, { lastInvoiceMonth: { gte: month } }],
        },
        orderBy: { purchaseDate: 'desc' },
        include: { responsible: { select: { id: true, name: true, color: true } } },
      },
    },
  });

  return cards.map((card) => buildInvoice(card, month));
}

function buildInvoice(
  card: CreditCard & {
    invoices: { status: string; paidAt: Date | null; overrideCents: number | null }[];
    purchases: (CardPurchase & { responsible: { id: string; name: string; color: string } | null })[];
  },
  month: string,
) {
  const items = card.purchases.flatMap((p) => {
    const charge = chargeFor(p, month);
    if (!charge) return [];
    return [
      {
        purchaseId: p.id,
        description: p.description,
        category: p.category,
        purchaseDate: toISODate(p.purchaseDate),
        recurring: p.recurring,
        installment: charge.installment,
        installments: p.installments,
        totalCents: p.totalCents,
        amountCents: charge.amountCents,
        responsible: p.responsible,
      },
    ];
  });
  const computedCents = items.reduce((s, i) => s + i.amountCents, 0);
  const row = card.invoices[0];
  const overrideCents = row?.overrideCents ?? null;

  return {
    cardId: card.id,
    cardName: card.name,
    color: card.color,
    closingDay: card.closingDay,
    dueDay: card.dueDay,
    limitCents: card.limitCents,
    month,
    dueDate: toISODate(dueDateFor(month, card.dueDay)),
    status: (row?.status ?? 'PENDENTE') as 'PENDENTE' | 'PAGO',
    paidAt: row?.paidAt ? toISODate(row.paidAt) : null,
    computedCents,
    overrideCents,
    totalCents: overrideCents ?? computedCents,
    items,
  };
}
