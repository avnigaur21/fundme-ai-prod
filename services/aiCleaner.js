const { callOpenRouter } = require('../utils/ai');
const { extractJSON } = require('../utils/jsonSanitizer');

/**
 * PRODUCTION AI CLEANER
 * ---------------------
 * The scraper now extracts structured fields directly from the HTML
 * (title, provider, type, amount, deadline, stage, description, link).
 *
 * This cleaner validates and enriches that data. It does NOT hallucinate
 * missing fields — it only augments what the scraper already captured.
 */

// ─── Quick sector inference (no AI needed) ───────────────────────────────────

const SECTOR_KEYWORDS = {
  // Order matters: more specific sectors first to avoid false positives
  'AgriTech':      ['agri', 'agriculture', 'farming', 'millet', 'crop', 'soil', 'food processing', 'agripreneur', 'nutrihub'],
  'FinTech':       ['fintech', 'financial', 'payment', 'banking', 'insurance', 'lending', 'credit'],
  'HealthTech':    ['health', 'medtech', 'medical', 'biotech', 'pharma', 'clinical', 'diagnostics', 'telemedicine'],
  'EdTech':        ['edtech', 'education', 'learning', 'university', 'campus fund'],
  'CleanTech':     ['cleantech', 'clean tech', 'renewable', 'solar', 'wind', 'climate', 'sustainability', 'carbon'],
  'DeepTech':      ['deeptech', 'deep tech', 'quantum', 'semiconductor', 'hardware', 'space', 'defence', 'defense', 'drones', 'military'],
  'Social Impact': ['social enterprise', 'social impact', 'ngo', 'nonprofit', 'inclusion', 'rural development', 'sanitation'],
  'Mobility':      ['mobility', 'electric vehicle', 'autonomous', 'automotive', 'motor india'],
  'SaaS':          ['saas', 'b2b software', 'enterprise software'],
  'Biotech':       ['biotech', 'biology', 'genomics', 'bioinformatics'],
  'Manufacturing': ['manufacturing', 'industrial', 'msme', 'factory'],
  'AI / ML':       ['artificial intelligence', 'machine learning', 'deep learning', 'generative ai', 'gen ai', 'llm', 'nlp', 'computer vision', 'ai accelerator', 'ai startup'],
};

function inferSector(text) {
  const lower = (text || '').toLowerCase();
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return sector;
  }
  return 'All Sectors';
}

// ─── Location inference ──────────────────────────────────────────────────────

const LOCATION_KEYWORDS = {
  'Pan India':    ['pan india', 'all india', 'nationwide', 'indian startups', 'indian founders'],
  'Bengaluru':    ['bengaluru', 'bangalore', 'karnataka'],
  'Delhi':        ['delhi', 'new delhi'],
  'Hyderabad':    ['hyderabad', 'telangana'],
  'Mumbai':       ['mumbai', 'maharashtra'],
  'Chennai':      ['chennai', 'tamil nadu'],
  'Kolkata':      ['kolkata', 'west bengal'],
  'Kerala':       ['kerala', 'thiruvananthapuram', 'kochi'],
  'Gujarat':      ['gujarat', 'ahmedabad'],
  'Global':       ['global', 'worldwide', 'international', 'remote'],
};

function inferLocation(text) {
  const lower = (text || '').toLowerCase();
  for (const [location, keywords] of Object.entries(LOCATION_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return location;
  }
  return 'India';
}

// ─── LISTING-LEVEL CLEANER (no AI call) ──────────────────────────────────────

/**
 * Clean and enrich a single scraped listing item.
 * This runs synchronously — no AI call needed since the scraper
 * already provides structured data from the HTML.
 */
function cleanListingItem(item) {
  const fullText = `${item.title} ${item.description} ${item.provider || ''}`;

  return {
    title:       item.title || '',
    provider:    item.provider || 'Startup Grants India',
    description: item.description || item.title || '',
    type:        item.type || 'Grant',
    amount:      item.amount || 'Variable',
    deadline:    item.deadline || 'Rolling',
    stage:       item.stage || '',
    sector:      inferSector(fullText),
    location:    inferLocation(fullText),
    link:        item.link || '',
    slug:        item.slug || '',
  };
}

// ─── DETAIL-LEVEL AI ENRICHMENT ──────────────────────────────────────────────

/**
 * Structures raw scraped detail text into clean, professional sections.
 * This IS an AI call — used only when a user opens the opportunity detail view.
 */
async function formatDetailedContent(rawText) {
  const prompt = `
  STRICT TASK: Partition the following scraped text into a professional, structured JSON format.
  Remove any internal noise like "95% off", "Loading...", "Exclusive deals", "Social media icons", "Coming Soon", "Sign in", or "create a free account".
  
  SCRAPED TEXT:
  ${rawText.substring(0, 6000)}

  RETURN ONLY VALID JSON WITH THESE EXACT KEYS:
  {
    "about": "2-3 professional sentences overviewing the opportunity.",
    "eligibility": ["bullet point 1", "bullet point 2"],
    "benefits": ["funding amount/award", "other perks"],
    "how_to_apply": ["step 1", "step 2"],
    "official_deadline": "string (readable)"
  }
  
  Do not include markdown blocks or conversational preamble. Only output the raw JSON object.
  `;

  try {
    const resText = await callOpenRouter(prompt);
    const cleanJson = extractJSON(resText);
    if (!cleanJson) throw new Error('No JSON found');
    
    return cleanJson;
  } catch (err) {
    console.error('formatDetailedContent Error:', err.message);
    return {
      about: 'Details are available on the official program page. Please view the link for full context.',
      eligibility: ['See official link for criteria.'],
      benefits: ['See official link for funding details.'],
      how_to_apply: ['Visit the provider website to start your application.'],
      official_deadline: 'Check official link',
    };
  }
}

// ─── LEGACY COMPAT EXPORT ────────────────────────────────────────────────────
// The old cleanWithAI is no longer needed for listings, but we keep the export
// name for backward compatibility. It now just returns the cleaned item.
async function cleanWithAI(data) {
  return cleanListingItem(data);
}

module.exports = { cleanWithAI, cleanListingItem, formatDetailedContent, inferSector, inferLocation };
