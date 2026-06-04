-- AlterTable: add introMessage and closingMessage to external_data_tool_configs
ALTER TABLE "external_data_tool_configs" ADD COLUMN IF NOT EXISTS "introMessage" TEXT;
ALTER TABLE "external_data_tool_configs" ADD COLUMN IF NOT EXISTS "closingMessage" TEXT;
