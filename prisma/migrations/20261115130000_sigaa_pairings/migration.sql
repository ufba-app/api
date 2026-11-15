-- CreateTable
CREATE TABLE "sigaa_pairings" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "label" TEXT,
    "client" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "pub" TEXT,
    "iv" TEXT,
    "ciphertext" TEXT,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "sigaa_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sigaa_pairings_expires_at_idx" ON "sigaa_pairings"("expires_at");

-- AddForeignKey
ALTER TABLE "sigaa_pairings" ADD CONSTRAINT "sigaa_pairings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

