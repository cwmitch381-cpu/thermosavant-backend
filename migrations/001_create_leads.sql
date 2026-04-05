-- ThermoSavant leads table
-- Run this once to create the database schema

CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  contractor_name VARCHAR(255),
  contractor_company VARCHAR(255),
  contractor_email VARCHAR(255),
  building_owner_name VARCHAR(255),
  building_owner_email VARCHAR(255),
  building_type VARCHAR(100),
  monthly_bill NUMERIC(10,2),
  annual_savings NUMERIC(10,2),
  payback_years NUMERIC(5,2),
  units_recommended INTEGER,
  proposal_generated_at TIMESTAMPTZ,
  status VARCHAR(50) DEFAULT 'proposal_sent',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_leads_contractor_email ON leads(contractor_email);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_building_type ON leads(building_type);
