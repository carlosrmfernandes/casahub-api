import { buildApp } from './app';

try {
  process.loadEnvFile();
} catch {
  // Sem .env (ex: Railway): usa as variáveis do ambiente.
}

async function main() {
  const app = await buildApp();
  const port = Number(process.env.PORT ?? 3333);
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
