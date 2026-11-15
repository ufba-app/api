-- CreateTable
CREATE TABLE "siasb_disciplines" (
    "user_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "siasb_disciplines_pkey" PRIMARY KEY ("user_id","id")
);

-- AddForeignKey
ALTER TABLE "siasb_disciplines" ADD CONSTRAINT "siasb_disciplines_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

