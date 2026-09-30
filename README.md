# casahub-api — Casa em Dia

API (Fastify + Prisma + PostgreSQL) do app Casa em Dia: contas fixas e avulsas, cartões com parcelas, entradas, reservas, tarefas, lista de compras e agenda da família.

## Rodar local

1. Crie o banco no PostgreSQL (uma vez):
   ```sql
   CREATE USER casahub WITH PASSWORD 'casahub';
   CREATE DATABASE casahub OWNER casahub;
   ```
2. Copie `.env.example` para `.env` e troque o `JWT_SECRET`.
3. ```
   npm install
   npx prisma migrate deploy
   npm run dev
   ```
   A API sobe em http://localhost:3333 (`GET /health`).

## Como funciona

- **Conta fixa** (`/recurring-bills`): cadastrada uma vez, com mês final opcional (ex: Casa SP até dezembro). Ao abrir um mês, os lançamentos (`/bills`) são criados automaticamente. Contas de valor variável (água, luz) usam o último valor pago como estimativa.
- **Cartão** (`/cards`): compras parceladas caem na fatura certa pelo dia de fechamento; assinaturas se repetem até serem canceladas.
- **Início** (`/dashboard?month=AAAA-MM`): entradas, gastos, pago, falta pagar, quanto sobra, atrasadas e previsão de 6 meses.
- **Agenda** (`/calendar`): compromissos, vencimentos, faturas, tarefas e entradas do mês.

## Deploy na Vercel

A Vercel roda a API como função (`api/index.ts` + `vercel.json`). Variáveis de ambiente do projeto na Vercel:

- `DATABASE_URL`: use o **pooler** do Supabase (a Vercel não conecta no endereço direto `db.*.supabase.co`, que é só IPv6):
  `postgresql://postgres.<ref>:<senha>@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1`
- `JWT_SECRET`: um segredo longo e aleatório.
- `CORS_ORIGIN`: vazio para liberar todas as origens.

As migrações não rodam na Vercel: rode `npx prisma migrate deploy` localmente (com o endereço direto no `.env`).
