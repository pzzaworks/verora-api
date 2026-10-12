-- DropIndex
DROP INDEX "queries_oracle_state_deadline_idx";

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "metadata_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "metadata_retry_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "queries" ADD COLUMN     "next_settle_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "settle_attempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "metadata_documents" ADD COLUMN     "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "queries_oracle_state_next_settle_at_idx" ON "queries"("oracle_state", "next_settle_at");

-- CreateIndex
CREATE INDEX "assets_owner_idx" ON "assets"("owner");

