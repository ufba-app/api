import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  // Pasta: o Prisma lê `schema.prisma` e todos os `.prisma` em `models/`.
  schema: 'prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `prisma generate` nao conecta ao banco: aceita a ausencia da variavel (build sem .env).
    url: process.argv.includes('generate')
      ? (process.env.DATABASE_URL ?? 'postgresql://localhost:5432/platform')
      : env('DATABASE_URL'),
  },
});
