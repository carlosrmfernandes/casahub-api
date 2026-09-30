/** Utilitários de mês ("YYYY-MM") e datas sem hora ("YYYY-MM-DD"), no fuso de São Paulo. */

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TZ = 'America/Sao_Paulo';

export function todayISO(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

export function currentMonth(): string {
  return todayISO().slice(0, 7);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Quantos meses de `from` até `to` (to - from). */
export function monthDiff(from: string, to: string): number {
  const [y1, m1] = from.split('-').map(Number);
  const [y2, m2] = to.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Data de vencimento no mês, ajustando dia 31 em meses curtos. */
export function dueDateFor(month: string, day: number): Date {
  const d = Math.min(Math.max(day, 1), daysInMonth(month));
  return toDate(`${month}-${String(d).padStart(2, '0')}`);
}

export function toDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

export function monthBounds(month: string): { gte: Date; lte: Date } {
  return { gte: toDate(`${month}-01`), lte: dueDateFor(month, 31) };
}
