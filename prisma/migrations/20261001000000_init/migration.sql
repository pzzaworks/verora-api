-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata_uri" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "admin_suspended" BOOLEAN NOT NULL DEFAULT false,
    "registered_at" TIMESTAMP(3) NOT NULL,
    "reputation" INTEGER NOT NULL DEFAULT 5000,
    "total_queries" INTEGER NOT NULL DEFAULT 0,
    "successful_queries" INTEGER NOT NULL DEFAULT 0,
    "failed_queries" INTEGER NOT NULL DEFAULT 0,
    "total_stake" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "staker_count" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "metadata_fetched_at" TIMESTAMP(3),
    "metadata_error" TEXT,
    "health_status" TEXT NOT NULL DEFAULT 'unknown',
    "health_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queries" (
    "id" TEXT NOT NULL,
    "requester" TEXT NOT NULL,
    "query_type" TEXT NOT NULL,
    "query_data" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "payment" DECIMAL(78,0) NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "assigned_agents" TEXT[],
    "aggregated_result" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "finalized_at" TIMESTAMP(3),
    "tx_hash" TEXT NOT NULL,
    "block_number" BIGINT NOT NULL,
    "oracle_state" TEXT NOT NULL DEFAULT 'dispatching',
    "oracle_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "query_responses" (
    "query_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "response_data" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "tx_hash" TEXT NOT NULL,

    CONSTRAINT "query_responses_pkey" PRIMARY KEY ("query_id","agent_id")
);

-- CreateTable
CREATE TABLE "query_dispatches" (
    "query_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "query_dispatches_pkey" PRIMARY KEY ("query_id","agent_id")
);

-- CreateTable
CREATE TABLE "staking_events" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "staker" TEXT,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "query_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "payee" TEXT NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_state" (
    "id" TEXT NOT NULL,
    "last_block" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_nonces" (
    "nonce" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_nonces_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "metadata_documents" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metadata_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agents_owner_idx" ON "agents"("owner");

-- CreateIndex
CREATE INDEX "agents_status_reputation_idx" ON "agents"("status", "reputation");

-- CreateIndex
CREATE INDEX "queries_requester_created_at_idx" ON "queries"("requester", "created_at");

-- CreateIndex
CREATE INDEX "queries_status_idx" ON "queries"("status");

-- CreateIndex
CREATE INDEX "queries_oracle_state_deadline_idx" ON "queries"("oracle_state", "deadline");

-- CreateIndex
CREATE INDEX "query_responses_agent_id_idx" ON "query_responses"("agent_id");

-- CreateIndex
CREATE INDEX "query_dispatches_status_next_attempt_at_idx" ON "query_dispatches"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "staking_events_agent_id_kind_timestamp_idx" ON "staking_events"("agent_id", "kind", "timestamp");

-- CreateIndex
CREATE INDEX "staking_events_staker_idx" ON "staking_events"("staker");

-- CreateIndex
CREATE INDEX "payments_agent_id_idx" ON "payments"("agent_id");

-- CreateIndex
CREATE INDEX "payments_payee_idx" ON "payments"("payee");

-- CreateIndex
CREATE INDEX "auth_nonces_expires_at_idx" ON "auth_nonces"("expires_at");

-- CreateIndex
CREATE INDEX "metadata_documents_owner_idx" ON "metadata_documents"("owner");

-- AddForeignKey
ALTER TABLE "query_responses" ADD CONSTRAINT "query_responses_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "queries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "query_responses" ADD CONSTRAINT "query_responses_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "query_dispatches" ADD CONSTRAINT "query_dispatches_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "queries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

