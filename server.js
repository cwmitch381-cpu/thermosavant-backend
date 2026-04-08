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

// Save a contractor-generated lead/proposal
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
       proposal_generated_at, zip_code, source, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'contractor_generated',NOW())
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

// Save a consumer inbound lead (from /savings page)
app.post('/api/leads/consumer', asyncHandler(async (req, res) => {
  const {
    consumer_name, consumer_email, consumer_phone,
    building_type, monthly_bill, zip_code
  } = req.body;

  // Calculate estimated savings (simplified model)
  const bill = parseFloat(monthly_bill) || 0;
  const savingsPct = building_type === 'residential' ? 0.32 :
                     building_type === 'commercial' ? 0.28 : 0.30;
  const annual_savings = Math.round(bill * 12 * savingsPct);
  const payback_years = parseFloat((bill < 200 ? 5.5 : bill < 400 ? 4.2 : 3.5).toFixed(1));
  const units_recommended = bill < 200 ? 1 : bill < 400 ? 2 : bill < 800 ? 4 : 6;

  const result = await pool.query(
    `INSERT INTO leads 
      (building_owner_name, building_owner_email, building_type,
       monthly_bill, annual_savings, payback_years, units_recommended,
       zip_code, source, consumer_name, consumer_phone, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'consumer_inbound',$9,$10,NOW())
     RETURNING id, annual_savings, payback_years, units_recommended`,
    [
      consumer_name, consumer_email, building_type,
      bill, annual_savings, payback_years, units_recommended,
      zip_code || null,
      consumer_name, consumer_phone || null
    ]
  );

  // Also notify via Formspree (fire and forget)
  fetch('https://formspree.io/f/mlgooqew', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      _subject: `New Consumer Lead — ${zip_code || 'Unknown ZIP'} — $${bill}/mo`,
      name: consumer_name,
      email: consumer_email,
      phone: consumer_phone || 'Not provided',
      building_type,
      monthly_bill: `$${bill}`,
      zip_code: zip_code || 'Not provided',
      annual_savings: `$${annual_savings}`,
      payback: `${payback_years} years`,
      source: 'Consumer Savings Page',
    })
  }).catch(() => {});

  res.json({
    success: true,
    lead_id: result.rows[0].id,
    annual_savings: result.rows[0].annual_savings,
    payback_years: result.rows[0].payback_years,
    units_recommended: result.rows[0].units_recommended,
    monthly_savings: Math.round(annual_savings / 12)
  });
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
      COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as proposals_this_month,
      COUNT(CASE WHEN source = 'consumer_inbound' THEN 1 END) as consumer_leads
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
// ─── CONTRACTOR CRM ROUTES ────────────────────────────

// Contractor login with access code
app.post('/api/contractor/login', asyncHandler(async (req, res) => {
  const { access_code } = req.body;
  if (!access_code) return res.status(400).json({ error: 'Access code required' });

  const result = await pool.query(
    `SELECT id, name, company, email, phone, license FROM contractors 
     WHERE access_code = $1 AND is_active = true`,
    [access_code.trim().toUpperCase()]
  );

  if (!result.rows.length) {
    return res.status(401).json({ error: 'Invalid access code' });
  }

  const contractor = result.rows[0];
  // Store token in response (simple session token = contractor id + timestamp)
  const token = Buffer.from(`${contractor.id}:${Date.now()}`).toString('base64');
  
  res.json({ success: true, contractor, token });
}));

// Get contractor's leads pipeline
app.get('/api/contractor/leads', asyncHandler(async (req, res) => {
  const token = req.headers['x-contractor-token'];
  const contractor_id = await verifyContractorToken(token);
  if (!contractor_id) return res.status(401).json({ error: 'Unauthorized' });

  const leads = await pool.query(
    `SELECT * FROM leads 
     WHERE contractor_email = (SELECT email FROM contractors WHERE id = $1)
        OR contractor_id = $1
     ORDER BY created_at DESC`,
    [contractor_id]
  );

  res.json(leads.rows);
}));

// Get contractor stats
app.get('/api/contractor/stats', asyncHandler(async (req, res) => {
  const token = req.headers['x-contractor-token'];
  const contractor_id = await verifyContractorToken(token);
  if (!contractor_id) return res.status(401).json({ error: 'Unauthorized' });

  const contractor = await pool.query(
    `SELECT email FROM contractors WHERE id = $1`, [contractor_id]
  );
  const email = contractor.rows[0]?.email;

  const stats = await pool.query(`
    SELECT
      COUNT(*) as total_leads,
      COUNT(CASE WHEN lead_status = 'proposal_sent' THEN 1 END) as proposals_sent,
      COUNT(CASE WHEN lead_status = 'follow_up' THEN 1 END) as follow_ups,
      COUNT(CASE WHEN lead_status = 'won' THEN 1 END) as won,
      COUNT(CASE WHEN lead_status = 'lost' THEN 1 END) as lost,
      COALESCE(SUM(annual_savings), 0) as pipeline_value,
      COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as this_month
    FROM leads
    WHERE contractor_email = $1 OR contractor_id = $2
  `, [email, contractor_id]);

  res.json(stats.rows[0]);
}));

// Update lead status
app.patch('/api/contractor/leads/:id', asyncHandler(async (req, res) => {
  const token = req.headers['x-contractor-token'];
  const contractor_id = await verifyContractorToken(token);
  if (!contractor_id) return res.status(401).json({ error: 'Unauthorized' });

  const { lead_status, notes } = req.body;
  const { id } = req.params;

  const contractor = await pool.query(
    `SELECT email FROM contractors WHERE id = $1`, [contractor_id]
  );
  const email = contractor.rows[0]?.email;

  await pool.query(
    `UPDATE leads SET 
       lead_status = COALESCE($1, lead_status),
       notes = COALESCE($2, notes)
     WHERE id = $3 AND (contractor_email = $4 OR contractor_id = $5)`,
    [lead_status, notes, id, email, contractor_id]
  );

  res.json({ success: true });
}));

// Helper: verify contractor token
async function verifyContractorToken(token) {
  if (!token) return null;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [id] = decoded.split(':');
    const result = await pool.query(
      `SELECT id FROM contractors WHERE id = $1 AND is_active = true`, [parseInt(id)]
    );
    return result.rows.length ? parseInt(id) : null;
  } catch { return null; }
}
