const BASE_URL = process.env.FUNDME_API_URL || "http://localhost:3000";

/**
 * Generic helper to call the FundMe API endpoints
 */
async function callAPI(endpoint, body) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${endpoint} returned HTTP ${res.status}: ${errText}`);
  }

  return await res.json();
}

// ─── ADAPTERS ──────────────────────────────────────────────────────────────────
// Each adapter wraps a real API endpoint and maps the eval dataset input
// to the specific request body format the endpoint expects.

/**
 * /api/ai/generate-profile
 * Expects: { startup_overview: string }
 * The dataset input is a plain description string.
 */
async function generateProfile(input) {
  const res = await callAPI("/api/ai/generate-profile", {
    startup_overview: input
  });
  return res.result || res;
}

/**
 * /api/ai/summarize-opportunity
 * Expects: { description: string }
 * The dataset input is a plain description string.
 */
async function summarizeOpportunity(input) {
  const res = await callAPI("/api/ai/summarize-opportunity", {
    description: input
  });
  return res.result || res;
}

/**
 * /api/ai/eligibility
 * Expects: { profile: object, eligibility: string|array }
 * The dataset input has { profile, eligibility, opportunity_title }.
 */
async function checkEligibility(input) {
  const res = await callAPI("/api/ai/eligibility", {
    profile: input.profile,
    eligibility: input.eligibility
  });
  return res.result || res;
}

/**
 * /api/ai/match-opportunities
 * Expects: { profile: object, opportunities: array }
 * The dataset input has { profile, opportunities } with real titles.
 */
async function matchOpportunities(input) {
  const opportunities = input.opportunities.map((o, i) => ({
    opportunity_id: `eval_opp_${i}`,
    title: o.title || `${o.sector} Opportunity`,
    description: `Opportunity for ${o.sector} startups at ${o.stage} stage`,
    ...o
  }));

  const res = await callAPI("/api/ai/match-opportunities", {
    profile: input.profile,
    opportunities
  });
  return res.result || res;
}

/**
 * /api/ai/format-details
 * Expects: { raw_text: string }
 * The dataset input is a plain text string.
 */
async function formatDetails(input) {
  const res = await callAPI("/api/ai/format-details", {
    raw_text: input
  });
  return res.result || res;
}

/**
 * cleanWithAI (internal function — no API endpoint)
 * Called directly from services/aiCleaner.js
 * Expects: { title: string, description: string }
 * Returns: { title, sector, deadline, location, type, summary, eligibility[] }
 */
const { cleanWithAI } = require('../services/aiCleaner');

async function cleanScraped(input) {
  return await cleanWithAI(input);
}

module.exports = {
  generateProfile,
  summarizeOpportunity,
  checkEligibility,
  matchOpportunities,
  formatDetails,
  cleanScraped
};
