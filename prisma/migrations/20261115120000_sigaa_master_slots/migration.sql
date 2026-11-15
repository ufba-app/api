-- CreateTable
CREATE TABLE "sigaa_master_slots" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "prf_salt" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_unlocked_at" TIMESTAMP(3),

    CONSTRAINT "sigaa_master_slots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sigaa_master_slots_user_id_credential_id_key" ON "sigaa_master_slots"("user_id", "credential_id");

-- AddForeignKey
ALTER TABLE "sigaa_master_slots" ADD CONSTRAINT "sigaa_master_slots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

