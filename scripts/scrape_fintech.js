const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');
const { 
  scrapeOpportunityDetailData, 
  scrapeStartupGrants 
} = require('../services/scraper');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const FINTECH_URL = 'https://www.startupgrantsindia.com/industry/fintech';

function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

async function scrapeFintechOpportunities() {
  console.log('🚀 Starting Fintech-specific scrape...');
  
  // We'll use the existing scraper but target the fintech category
  // Since scrapeStartupGrants is hardcoded to BASE_URL, we'll manually fetch the listing
  
  let allFintechItems = [];
  const maxPages = 3; // Let's get the first 3 pages (approx 30-45 items)

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? FINTECH_URL : `${FINTECH_URL}?page=${page}`;
    console.log(`📄 Fetching Fintech page ${page}: ${url}`);
    
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        }
      });
      
      // Use the existing parser from the service if possible, or just copy the logic
      // The parseListingPage is not exported, so I'll replicate the core logic here
      const $ = cheerio.load(response.data);
      const cards = $('div.group.relative');
      
      cards.each((_, cardEl) => {
        const $card = $(cardEl);
        const $titleLink = $card.find('h2 a').first();
        if (!$titleLink.length) return;
        
        const href = $titleLink.attr('href') || '';
        const absoluteUrl = href.startsWith('http') ? href : 'https://www.startupgrantsindia.com' + href;
        const title = $titleLink.text().trim();
        const slug = href.replace(/^\//, '').replace(/\/$/, '');
        
        allFintechItems.push({
          title,
          link: absoluteUrl,
          slug,
          sector: 'Fintech'
        });
      });
      
      console.log(`✅ Found ${cards.length} items on page ${page}`);
      if (cards.length === 0) break;
      
    } catch (err) {
      console.error(`❌ Error fetching ${url}:`, err.message);
      break;
    }
  }

  console.log(`\n🔍 Found ${allFintechItems.length} Fintech opportunities. Enriching details...`);
  
  const db = readDB();
  const existingSlugs = new Set(db.opportunities.map(o => o.slug));
  const existingLinks = new Set(db.opportunities.map(o => o.link));
  
  let addedCount = 0;
  
  // Limit to 15 items for now to avoid overloading
  const toEnrich = allFintechItems.filter(item => !existingSlugs.has(item.slug) && !existingLinks.has(item.link)).slice(0, 15);
  console.log(`✨ ${toEnrich.length} are new. Starting enrichment...`);

  for (const item of toEnrich) {
    try {
      const details = await scrapeOpportunityDetailData(item.link);
      if (!details || !details.title) {
        console.warn(`⚠️  Failed to get details for ${item.title}`);
        continue;
      }

      const now = new Date();
      const opp = {
        opportunity_id: 'opp_' + uuidv4().slice(0, 6),
        title: details.title || item.title,
        provider: details.provider || 'Startup Grants India',
        description: details.description || details.about?.substring(0, 200) || item.title,
        eligibility: details.eligibility || 'See opportunity page for detailed eligibility criteria.',
        benefits: details.benefits || '',
        timeline: details.timeline || '',
        about: details.about || '',
        type: details.type || 'Grant',
        amount: details.amount || 'Variable',
        deadline: details.deadline || 'Rolling',
        location: details.location || 'India',
        sector: 'Fintech',
        stage: details.stage || '',
        link: item.link,
        external_apply_url: details.external_apply_url || '',
        slug: item.slug,
        raw_scraped_text: details.raw_scraped_text || '',
        credibility_source: 'Verified via StartupGrantsIndia.com',
        match_score: 0,
        scraped_at: now.toISOString(),
        last_seen_at: now.toISOString(),
      };

      db.opportunities.push(opp);
      addedCount++;
      console.log(`✅ Added: ${opp.title}`);
      
      // Delay to be nice to the server
      await new Promise(r => setTimeout(r, 1000));
      
    } catch (err) {
      console.error(`❌ Error enriching ${item.title}:`, err.message);
    }
  }

  writeDB(db);
  console.log(`\n🎉 Done! Added ${addedCount} new Fintech opportunities to the database.`);
}

scrapeFintechOpportunities();
