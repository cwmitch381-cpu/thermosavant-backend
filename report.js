// ─── MARKET INTELLIGENCE REPORT ENGINE ───────────────
// Generates monthly PDF-like HTML report for Solthera
// Delivered via Formspree email, stored as JSON in DB

const FORMSPREE = 'https://formspree.io/f/mlgooqew';
const SOLTHERA_EMAIL = 'cwmitch381@gmail.com'; // Update when Solthera onboarded

async function generateMonthlyReport(pool) {
  const now = new Date();
  const monthName = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  // ── PULL ALL DATA ─────────────────────────────────
  const [totals, thisMonth, lastMonth, byZip, byType, byContractor, topLeads, consumerLeads] = await Promise.all([
    // All-time totals
    pool.query(`
      SELECT COUNT(*) as total_proposals,
        COUNT(DISTINCT contractor_email) as total_contractors,
        COALESCE(SUM(annual_savings),0) as total_savings,
        COALESCE(SUM(units_recommended),0) as total_units,
        COALESCE(AVG(payback_years),0) as avg_payback,
        COUNT(CASE WHEN lead_status='won' THEN 1 END) as won,
        COUNT(CASE WHEN source='consumer_inbound' THEN 1 END) as consumer_leads
      FROM leads`),

    // This month
    pool.query(`
      SELECT COUNT(*) as proposals,
        COALESCE(SUM(annual_savings),0) as savings,
        COALESCE(SUM(units_recommended),0) as units,
        COUNT(CASE WHEN source='consumer_inbound' THEN 1 END) as consumer_leads
      FROM leads WHERE created_at >= $1`, [startOfMonth]),

    // Last month (for comparison)
    pool.query(`
      SELECT COUNT(*) as proposals,
        COALESCE(SUM(annual_savings),0) as savings
      FROM leads WHERE created_at >= $1 AND created_at < $2`,
      [startOfLastMonth, endOfLastMonth]),

    // By zip code
    pool.query(`
      SELECT zip_code, COUNT(*) as count,
        COALESCE(SUM(annual_savings),0) as savings
      FROM leads WHERE zip_code IS NOT NULL AND zip_code != ''
      GROUP BY zip_code ORDER BY count DESC LIMIT 10`),

    // By building type
    pool.query(`
      SELECT building_type, COUNT(*) as count,
        COALESCE(SUM(annual_savings),0) as savings,
        COALESCE(AVG(payback_years),0) as avg_payback
      FROM leads GROUP BY building_type ORDER BY count DESC`),

    // By contractor
    pool.query(`
      SELECT contractor_company, contractor_name, contractor_email,
        COUNT(*) as proposals,
        COALESCE(SUM(annual_savings),0) as pipeline_value,
        COUNT(CASE WHEN lead_status='won' THEN 1 END) as won
      FROM leads
      WHERE contractor_email IS NOT NULL AND contractor_email != ''
      GROUP BY contractor_company, contractor_name, contractor_email
      ORDER BY proposals DESC LIMIT 10`),

    // Top 5 leads by savings this month
    pool.query(`
      SELECT building_owner_name, building_type, zip_code,
        annual_savings, payback_years, units_recommended, lead_status, created_at
      FROM leads WHERE created_at >= $1
      ORDER BY annual_savings DESC LIMIT 5`, [startOfMonth]),

    // Consumer inbound trend
    pool.query(`
      SELECT DATE_TRUNC('week', created_at) as week,
        COUNT(*) as count
      FROM leads WHERE source='consumer_inbound'
      AND created_at >= NOW() - INTERVAL '8 weeks'
      GROUP BY week ORDER BY week`)
  ]);

  const t = totals.rows[0];
  const tm = thisMonth.rows[0];
  const lm = lastMonth.rows[0];

  const growth = lm.proposals > 0
    ? Math.round(((tm.proposals - lm.proposals) / lm.proposals) * 100)
    : tm.proposals > 0 ? 100 : 0;

  // ── BUILD EMAIL BODY ──────────────────────────────
  const emailBody = buildReportEmail({
    monthName, totals: t, thisMonth: tm, lastMonth: lm,
    growth, byZip: byZip.rows, byType: byType.rows,
    byContractor: byContractor.rows, topLeads: topLeads.rows,
    consumerTrend: consumerLeads.rows
  });

  // ── SEND VIA FORMSPREE ────────────────────────────
  const res = await fetch(FORMSPREE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      _subject: `ThermoSavant Market Intelligence Report — ${monthName}`,
      to_email: SOLTHERA_EMAIL,
      from_name: 'ThermoSavant AI',
      message: emailBody,
      report_month: monthName,
      total_proposals: t.total_proposals,
      total_savings: `$${Math.round(t.total_savings).toLocaleString()}`,
      this_month_proposals: tm.proposals,
      growth_pct: `${growth > 0 ? '+' : ''}${growth}%`,
    })
  });

  return {
    success: res.ok,
    month: monthName,
    proposals_this_month: parseInt(tm.proposals),
    total_savings: Math.round(t.total_savings),
    growth_pct: growth,
    contractors: parseInt(t.total_contractors),
    top_zip: byZip.rows[0]?.zip_code || 'N/A'
  };
}

function buildReportEmail({ monthName, totals, thisMonth, lastMonth, growth, byZip, byType, byContractor, topLeads }) {
  const fmt = n => Math.round(n).toLocaleString();
  const arrow = growth >= 0 ? '▲' : '▼';
  const sign = growth >= 0 ? '+' : '';

  const zipRows = byZip.slice(0, 8).map((z, i) =>
    `  ${i+1}. ${z.zip_code} — ${z.count} proposals · $${fmt(z.savings)}/yr projected`
  ).join('\n') || '  No zip code data yet';

  const typeRows = byType.map(t =>
    `  ${(t.building_type || 'Unknown').padEnd(20)} ${String(t.count).padStart(3)} proposals · $${fmt(t.savings)}/yr · ${parseFloat(t.avg_payback).toFixed(1)}yr payback`
  ).join('\n') || '  No data yet';

  const contractorRows = byContractor.slice(0, 5).map((c, i) =>
    `  ${i+1}. ${(c.contractor_company || c.contractor_name || 'Unknown').padEnd(25)} ${String(c.proposals).padStart(3)} proposals · $${fmt(c.pipeline_value)} pipeline · ${c.won} won`
  ).join('\n') || '  No contractor data yet';

  const topLeadRows = topLeads.map((l, i) =>
    `  ${i+1}. ${(l.building_owner_name || 'Unknown').padEnd(20)} ${(l.building_type || '').padEnd(15)} ZIP ${l.zip_code || '—'} · $${fmt(l.annual_savings)}/yr · ${l.payback_years}yr payback`
  ).join('\n') || '  No proposals this month yet';

  return `THERMOSAVANT AI — MARKET INTELLIGENCE REPORT
${monthName.toUpperCase()}
${'═'.repeat(60)}

EXECUTIVE SUMMARY
─────────────────
This month: ${thisMonth.proposals} proposals  (${arrow} ${sign}${growth}% vs last month)
All-time:   ${totals.total_proposals} total proposals · ${totals.total_contractors} active contractors
Pipeline:   $${fmt(totals.total_savings)}/yr projected savings across all proposals
Units:      ${fmt(totals.total_units)} ThermoCore units recommended
Consumer:   ${totals.consumer_leads} inbound leads from thermosavantai.com/savings

${'─'.repeat(60)}
THIS MONTH AT A GLANCE
─────────────────────
Proposals Generated:  ${thisMonth.proposals}
Projected Savings:    $${fmt(thisMonth.savings)}/yr
Units Recommended:    ${fmt(thisMonth.units)}
Consumer Inbound:     ${thisMonth.consumer_leads}
MoM Growth:          ${arrow} ${sign}${growth}%

${'─'.repeat(60)}
TOP ZIP CODES BY ACTIVITY
─────────────────────────
${zipRows}

${'─'.repeat(60)}
BUILDING TYPE BREAKDOWN
───────────────────────
${typeRows}

${'─'.repeat(60)}
INSTALLER RANKINGS (ALL-TIME)
─────────────────────────────
${contractorRows}

${'─'.repeat(60)}
TOP PROPOSALS THIS MONTH (BY SAVINGS)
──────────────────────────────────────
${topLeadRows}

${'─'.repeat(60)}
MARKET OPPORTUNITIES
────────────────────
Based on this month's data:

${byZip.length > 0 ? `• Highest activity: ZIP ${byZip[0].zip_code} (${byZip[0].count} proposals)` : '• No zip data yet — ensure contractors enter zip codes'}
${parseInt(totals.consumer_leads) > 0 ? `• ${totals.consumer_leads} consumer leads captured — route to nearest installer` : '• Consumer lead capture active at thermosavantai.com/savings'}
${parseInt(totals.total_contractors) < 3 ? '• Opportunity: expand installer network in Northern Colorado' : `• ${totals.total_contractors} installers active — consider expanding to Denver metro`}

${'─'.repeat(60)}
PLATFORM STATUS
───────────────
✓ thermosavantai.com/savings — consumer lead capture live
✓ thermosavantai.com/portal.html — this portal, real-time data
✓ thermosavantai.com/dashboard.html — contractor CRM active
✓ Automated follow-up sequences running (Day 7 + Day 14)
✓ Market heat map updated with all proposal zip codes

${'═'.repeat(60)}
ThermoSavant AI  ·  thermosavantai.com
This report is generated automatically on the 1st of each month.
Questions? Reply to this email or contact cwmitch381@gmail.com
`;
}

module.exports = { generateMonthlyReport };
