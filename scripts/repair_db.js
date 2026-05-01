const fs = require('fs');
const path = require('path');
const { cleanWithAI } = require('../services/aiCleaner');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

async function repairDB() {
  console.log('🚀 Starting Database Repair Worker...');
  
  if (!fs.existsSync(DB_PATH)) {
    console.error('❌ Database not found at:', DB_PATH);
    return;
  }

  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const opportunities = db.opportunities;
  let fixedCount = 0;

  console.log(`🔍 Scanning ${opportunities.length} opportunities for quality issues...`);

  for (let i = 0; i < opportunities.length; i++) {
    const opp = opportunities[i];
    
    // Check if it needs a repair: 
    // 1. Amount is generic
    // 2. OR Eligibility is empty/invalid
    // 3. AND we have raw text to work with 
    const needsRepair = (
      (opp.amount === 'Variable' || opp.amount === 'Not specified' || !opp.amount) ||
      (!opp.eligibility || (Array.isArray(opp.eligibility) && opp.eligibility.length === 0))
    ) && (opp.raw_scraped_text && opp.raw_scraped_text.length > 100);

    if (needsRepair) {
      console.log(`✨ Repairing [${i+1}/${opportunities.length}]: ${opp.title}...`);
      
      try {
        const cleaned = await cleanWithAI({
          title: opp.title,
          description: opp.raw_scraped_text
        });

        // Update fields safely
        opp.title = cleaned.title || opp.title;
        opp.sector = cleaned.sector || opp.sector;
        opp.amount = cleaned.amount || opp.amount;
        opp.deadline = cleaned.deadline || opp.deadline;
        opp.location = cleaned.location || opp.location;
        opp.type = cleaned.type || opp.type;
        opp.description = cleaned.summary || cleaned.description || opp.description;
        opp.eligibility = cleaned.eligibility || opp.eligibility;
        
        // Also capture benefits if available
        if (cleaned.benefits) {
            opp.benefits = cleaned.benefits;
        }

        fixedCount++;
        
        // Save incrementally every 3 repairs to avoid lost progress on crash
        if (fixedCount % 3 === 0) {
            fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
            console.log('💾 Progress saved...');
        }

        // Throttle to respect API limits
        await new Promise(r => setTimeout(r, 2000));
        
      } catch (err) {
        console.error(`❌ Failed to repair ${opp.title}:`, err.message);
      }
    }
  }

  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  console.log(`\n✅ Repair Complete. Fixed ${fixedCount} entries.`);
}

repairDB();
