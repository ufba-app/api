-- AlterEnum
ALTER TYPE "SourceProvider" ADD VALUE 'SIASB';

-- AlterTable
ALTER TABLE "source_accounts" ADD COLUMN "expires_at" TIMESTAMP(3);
