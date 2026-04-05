require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(express.json());
app.use(cors({
  origin: ['https://thermosavantai.com', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Async handler wrapper
const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ─── ROUTES ───────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Save a lead/proposal when contractor generates one
app.post('/api/leads', asyncHandler(async (req, res) => {
  const {
    contractor_name,
    contractor_company,
    contractor_email,
    building_owner_name,
    building_owner_email,
    building_type,
    monthly_bill,
    annual_savings,
    payback_years,
    units_recommended,
    proposal_generated_at
  } = req.body;

  const result = await pool.query(
    `INSERT INTO leads 
      (contractor_name, contractor_company, contractor_email, 
       building_owner_name, building_owner_email, building_type,
       monthly_bill, annual_savings, payback_years, units_recommended,
       proposal_generated_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     RETURNING id`,
    [
      contractor_name, contractor_company, contractor_email,
      building_owner_name, building_owner_email, building_type,
      monthly_bill, annual_savings, payback_years, units_recommended,
      proposal_generated_at || new Date().toISOString()
    ]
  );

  res.json({ success: true, lead_id: result.rows[0].id });
}));

// Get all leads - used by Solthera portal
app.get('/api/portal/leads', asyncHandler(async (req, res) => {
  const { password } = req.headers;
  if (password !== process.env.PORTAL_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const leads = await pool.query(
    `SELECT * FROM leads ORDER BY created_at DESC`
  );
  res.json(leads.rows);
}));

// Get summary stats - used by Solthera portal dashboard
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
    FROM leads
    GROUP BY building_type
    ORDER BY count DESC
  `);

  const recent = await pool.query(`
    SELECT * FROM leads ORDER BY created_at DESC LIMIT 10
  `);

  res.json({
    summary: stats.rows[0],
    by_building_type: byType.rows,
    recent_proposals: recent.rows
  });
}));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`ThermoSavant backend running on port ${PORT}`);
});
