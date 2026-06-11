-- Repair: ensure introMessage and closingMessage exist in external_data_tool_configs
-- These were added in 20260604000000_add_tool_config_messages but may not have been
-- applied correctly in all production environments.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'external_data_tool_configs' AND column_name = 'introMessage'
  ) THEN
    ALTER TABLE "external_data_tool_configs" ADD COLUMN "introMessage" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'external_data_tool_configs' AND column_name = 'closingMessage'
  ) THEN
    ALTER TABLE "external_data_tool_configs" ADD COLUMN "closingMessage" TEXT;
  END IF;
END $$;
