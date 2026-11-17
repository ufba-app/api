-- CreateTable
CREATE TABLE "source_health" (
    "user_id" UUID NOT NULL,
    "provider" "SourceProvider" NOT NULL,
    "account_key" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "last_success_at" TIMESTAMP(3),
    "last_failure_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_health_pkey" PRIMARY KEY ("user_id","provider","account_key")
);

-- AddForeignKey
ALTER TABLE "source_health" ADD CONSTRAINT "source_health_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
