// ─── AUTOMATED FOLLOW-UP ENGINE ──────────────────────
// Called by GET /api/cron/followup (Railway cron or manual trigger)
// Sends Day 7 and Day 14 follow-up emails via Formspree

const FORMSPREE = 'https://formspree.io/f/mlgooqew';
const NOTIFY_EMAIL = 'cwmitch381@gmail.com';

async function runFollowUps(pool) {
  const now = new Date();
  const results = { processed: 0, sent: 0, skipped: 0, errors: 0 };

  // Find leads eligible for Day 7 follow-up:
  // - Created 7+ days ago, status still proposal_sent, follow_up_count = 0, follow_up_enabled = true
  // - Has building owner email OR consumer email
  const day7Leads = await pool.query(`
    SELECT l.*, c.name as contractor_name_full, c.company as contractor_company_full,
           c.email as contractor_email_addr, c.phone as contractor_phone_num
    FROM leads l
    LEFT JOIN contractors c ON l.contractor_id = c.id
    WHERE l.follow_up_enabled = true
      AND l.follow_up_count = 0
      AND l.lead_status = 'proposal_sent'
      AND l.created_at <= NOW() - INTERVAL '7 days'
      AND (l.building_owner_email IS NOT NULL AND l.building_owner_email != ''
           OR l.consumer_name IS NOT NULL)
      AND l.source != 'consumer_inbound'
    LIMIT 20
  `);

  // Day 14 follow-up: follow_up_count = 1, created 14+ days ago
  const day14Leads = await pool.query(`
    SELECT l.*, c.name as contractor_name_full, c.company as contractor_company_full,
           c.email as contractor_email_addr, c.phone as contractor_phone_num
    FROM leads l
    LEFT JOIN contractors c ON l.contractor_id = c.id
    WHERE l.follow_up_enabled = true
      AND l.follow_up_count = 1
      AND l.lead_status = 'proposal_sent'
      AND l.last_follow_up_at <= NOW() - INTERVAL '7 days'
      AND (l.building_owner_email IS NOT NULL AND l.building_owner_email != '')
    LIMIT 20
  `);

  const allLeads = [
    ...day7Leads.rows.map(l => ({ ...l, followUpDay: 7 })),
    ...day14Leads.rows.map(l => ({ ...l, followUpDay: 14 })),
  ];

  results.processed = allLeads.length;

  for (const lead of allLeads) {
    try {
      const sent = await sendFollowUp(lead, lead.followUpDay);
      if (sent) {
        // Update follow_up_count and last_follow_up_at
        await pool.query(
          `UPDATE leads SET 
            follow_up_count = follow_up_count + 1,
            last_follow_up_at = NOW(),
            lead_status = CASE WHEN lead_status = 'proposal_sent' THEN 'follow_up' ELSE lead_status END
           WHERE id = $1`,
          [lead.id]
        );
        results.sent++;
      } else {
        results.skipped++;
      }
    } catch (err) {
      console.error(`Follow-up error for lead ${lead.id}:`, err.message);
      results.errors++;
    }
  }

  return results;
}

async function sendFollowUp(lead, day) {
  const ownerName = lead.building_owner_name || lead.consumer_name || 'there';
  const ownerEmail = lead.building_owner_email;
  if (!ownerEmail) return false;

  const contractorName = lead.contractor_name_full || lead.contractor_name || 'Your ThermoSavant Installer';
  const company = lead.contractor_company_full || lead.contractor_company || '';
  const annual = Math.round(lead.annual_savings || 0).toLocaleString();
  const payback = lead.payback_years ? `${lead.payback_years} years` : '3–5 years';
  const fromName = company ? `${contractorName} · ${company}` : contractorName;

  let subject, message;

  if (day === 7) {
    subject = `Following up on your ThermoCore energy savings proposal`;
    message = `Hi ${ownerName},

I wanted to follow up on the ThermoCore energy savings proposal I sent over last week.

A quick reminder of what we put together for you:
• Projected annual savings: $${annual}
• Estimated payback period: ${payback} (after 30% federal tax credit)

Have you had a chance to review it? I'm happy to answer any questions, run through the numbers again, or schedule a quick 15-minute call.

There's no pressure — I just want to make sure you have everything you need to make the right decision for your property.

Best,
${fromName}

---
This is an automated follow-up from ThermoSavant AI. To opt out of future follow-ups, simply reply and let us know.`;
  } else {
    subject = `One last check-in on your ThermoCore proposal`;
    message = `Hi ${ownerName},

I wanted to reach out one more time about the ThermoCore proposal for your property.

Energy rates in Colorado have continued to rise — which actually means your projected savings of $${annual}/year may be even higher now than when we first ran the numbers.

If the timing isn't right, no problem at all. But if you'd like to revisit the proposal or get an updated estimate, I'm here.

Best,
${fromName}

---
This is the final automated follow-up from ThermoSavant AI.`;
  }

  const res = await fetch(FORMSPREE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      _replyto: lead.contractor_email_addr || lead.contractor_email || '',
      _subject: subject,
      to_email: ownerEmail,
      to_name: ownerName,
      from_name: fromName,
      message,
      follow_up_day: `Day ${day}`,
      lead_id: lead.id,
      annual_savings: `$${annual}`,
    })
  });

  if (!res.ok) {
    console.error(`Formspree error for lead ${lead.id}:`, res.status);
    return false;
  }

  // Also notify you so you know follow-ups are firing
  await fetch(FORMSPREE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      _subject: `[ThermoSavant] Day ${day} follow-up sent → ${ownerName} (Lead #${lead.id})`,
      to_email: NOTIFY_EMAIL,
      message: `Follow-up sent:\n\nLead ID: ${lead.id}\nOwner: ${ownerName}\nEmail: ${ownerEmail}\nContractor: ${fromName}\nAnnual savings: $${annual}\nDay: ${day}`,
    })
  }).catch(() => {});

  return true;
}

module.exports = { runFollowUps };
