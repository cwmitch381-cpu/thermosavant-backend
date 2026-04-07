-- Add zip_code to leads for heat map functionality
ALTER TABLE leads ADD COLUMN IF NOT EXISTS zip_code VARCHAR(10);
CREATE INDEX IF NOT EXISTS idx_leads_zip_code ON leads(zip_code);
