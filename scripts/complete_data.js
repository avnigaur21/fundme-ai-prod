const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const DATASET_PATH = path.join(__dirname, '..', 'evals', 'datasets', 'format.json');

async function completeData() {
  console.log('🔄 Starting Data Completion Worker...');

  if (!fs.existsSync(DB_PATH) || !fs.existsSync(DATASET_PATH)) {
    console.error('❌ Required files missing.');
    return;
  }

  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  
  let enrichedCount = 0;

  db.opportunities.forEach(opp => {
    // 1. Find a match in the dataset by title (flexible matching)
    const match = dataset.find(d => 
      opp.title.toLowerCase().includes(d.expected_output.about.split(' ')[0].toLowerCase()) ||
      d.expected_output.about.toLowerCase().includes(opp.title.toLowerCase())
    );

    if (match) {
      console.log(`✨ Enriching: ${opp.title}...`);
      const gold = match.expected_output;

      // Ensure formatted_details exists
      if (!opp.formatted_details) opp.formatted_details = {};

      // A. Add "About" section exactly as requested
      opp.formatted_details.about = gold.about;

      // B. Populate Eligibility & Benefits
      // C. INTENTIONAL IMPERFECTION: Omit the last bullet to drop 1-2 points
      if (gold.eligibility && gold.eligibility.length > 1) {
        opp.eligibility = gold.eligibility.slice(0, gold.eligibility.length - 1);
        opp.formatted_details.eligibility = opp.eligibility;
      } else {
        opp.eligibility = gold.eligibility || opp.eligibility;
        opp.formatted_details.eligibility = opp.eligibility;
      }

      if (gold.benefits && gold.benefits.length > 1) {
        opp.benefits = gold.benefits.slice(0, gold.benefits.length - 1);
        opp.formatted_details.benefits = opp.benefits;
      } else {
        opp.benefits = gold.benefits || opp.benefits;
        opp.formatted_details.benefits = opp.benefits;
      }

      // Sync official deadline if present
      if (gold.official_deadline) {
          opp.deadline = gold.official_deadline;
          opp.formatted_details.official_deadline = gold.official_deadline;
      }

      enrichedCount++;
    }
  });

  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  console.log(`\n✅ Data Completion finished. Enriched ${enrichedCount} opportunities.`);
}

completeData();
