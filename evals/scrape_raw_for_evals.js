/**
 * One-time script to scrape raw text from all opportunity detail pages
 * and save it for use in format.json eval dataset.
 * 
 * Usage: node evals/scrape_raw_for_evals.js
 */
const fs = require('fs');
const path = require('path');
const { scrapeDetails } = require('../services/scraper');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

async function main() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  const results = [];

  for (const opp of db.opportunities) {
    console.log(`Scraping: ${opp.title}...`);
    
    try {
      const raw = await scrapeDetails(opp.link);
      results.push({
        opportunity_id: opp.opportunity_id,
        title: opp.title,
        link: opp.link,
        raw_text: raw,
        raw_length: raw.length
      });
      console.log(`  ✅ Got ${raw.length} chars`);
    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}`);
      results.push({
        opportunity_id: opp.opportunity_id,
        title: opp.title,
        link: opp.link,
        raw_text: "",
        error: err.message
      });
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 2000));
  }

  const outPath = path.join(__dirname, 'datasets', '_raw_scraped.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nSaved to: ${outPath}`);
}

main();
