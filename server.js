require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(cors({
  origin: ['https://thermosavantai.com', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'password']
}));

const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Save a lead/proposal when contractor generates one
app.post('/api/leads', asyncHandler(async (req, res) => {
  const {
    contractor_name, contractor_company, contractor_email,
    building_owner_name, building_owner_email, building_type,
    monthly_bill, annual_savings, payback_years, units_recommended,
    proposal_generated_at, zip_code
  } = req.body;

  const result = await pool.query(
    `INSERT INTO leads 
      (contractor_name, contractor_company, contractor_email, 
       building_owner_name, building_owner_email, building_type,
       monthly_bill, annual_savings, payback_years, units_recommended,
       proposal_generated_at, zip_code, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     RETURNING id`,
    [
      contractor_name, contractor_company, contractor_email,
      building_owner_name, building_owner_email, building_type,
      monthly_bill, annual_savings, payback_years, units_recommended,
      proposal_generated_at || new Date().toISOString(),
      zip_code || null
    ]
  );

  res.json({ success: true, lead_id: result.rows[0].id });
}));

// Get all leads - Solthera portal
app.get('/api/portal/leads', asyncHandler(async (req, res) => {
  const { password } = req.headers;
  if (password !== process.env.PORTAL_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const leads = await pool.query(`SELECT * FROM leads ORDER BY created_at DESC`);
  res.json(leads.rows);
}));

// Get summary stats - Solthera portal dashboard
app.get('/api/portal/stats', asyncHandler(async (req, res) => {
  const { password } = req.headers;
  if (password !== process.env.PORTAL_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const stats = await pool.query(`
    SELECT
      COUNT(*) as total_proposals,
      COUNT(DISTINCT contractor_email) as active_contractors,
      COALESCE(SUM(annual_savings), 0) as total_projected_savings,
      COALESCE(AVG(payback_years), 0) as avg_payback_years,
      COALESCE(SUM(units_recommended), 0) as total_units_recommended,
      COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as proposals_this_week,
      COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as proposals_this_month
    FROM leads
  `);

  const byType = await pool.query(`
    SELECT building_type, COUNT(*) as count, COALESCE(SUM(annual_savings),0) as total_savings
    FROM leads GROUP BY building_type ORDER BY count DESC
  `);

  const recent = await pool.query(`SELECT * FROM leads ORDER BY created_at DESC LIMIT 10`);

  res.json({
    summary: stats.rows[0],
    by_building_type: byType.rows,
    recent_proposals: recent.rows
  });
}));

// Heat map data - proposals grouped by zip code
app.get('/api/portal/map', asyncHandler(async (req, res) => {
  const { password } = req.headers;
  if (password !== process.env.PORTAL_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const data = await pool.query(`
    SELECT
      zip_code,
      COUNT(*) as proposal_count,
      COALESCE(SUM(annual_savings), 0) as total_savings,
      COALESCE(AVG(payback_years), 0) as avg_payback,
      COALESCE(SUM(units_recommended), 0) as total_units,
      COUNT(DISTINCT contractor_email) as contractor_count,
      MAX(created_at) as last_activity
    FROM leads
    WHERE zip_code IS NOT NULL AND zip_code != ''
    GROUP BY zip_code
    ORDER BY proposal_count DESC
  `);

  res.json(data.rows);
}));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`ThermoSavant backend running on port ${PORT}`);
});
