/**
 * Data Cleanup Script
 * Fixes duplicate users, calculates profile completion, and cleans up data inconsistencies
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function readDB() {
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function calculateProfileCompletion(profile) {
  const requiredFields = [
    'startup_name',
    'sector', 
    'stage',
    'startup_overview',
    'problem_statement',
    'solution_summary',
    'target_customers',
    'business_model',
    'founded_year',
    'location'
  ];

  const optionalFields = [
    'website',
    'application_email',
    'team_size'
  ];

  const documentFields = [
    'pitch_deck',
    'financial_projections', 
    'letters_of_support',
    'budget_breakdown'
  ];

  let completedRequired = 0;
  let completedOptional = 0;
  let completedDocuments = 0;
  const missingFields = [];

  // Check required fields
  requiredFields.forEach(field => {
    const value = profile[field];
    if (value && typeof value === 'string' && value.trim().length > 0) {
      completedRequired++;
    } else if (field === 'team_size' && value > 0) {
      completedRequired++;
    } else {
      missingFields.push(field);
    }
  });

  // Check optional fields
  optionalFields.forEach(field => {
    const value = profile[field];
    if (value && typeof value === 'string' && value.trim().length > 0) {
      completedOptional++;
    } else if (field === 'team_size' && value > 0) {
      completedOptional++;
    }
  });

  // Check document fields
  if (profile.documents) {
    documentFields.forEach(doc => {
      if (profile.documents[doc] && profile.documents[doc] !== null) {
        completedDocuments++;
      }
    });
  }

  // Calculate weighted score
  const requiredWeight = 0.7; // 70% weight for required fields
  const optionalWeight = 0.2; // 20% weight for optional fields  
  const documentWeight = 0.1; // 10% weight for documents

  const requiredScore = (completedRequired / requiredFields.length) * requiredWeight;
  const optionalScore = completedOptional > 0 ? (completedOptional / optionalFields.length) * optionalWeight : 0;
  const documentScore = (completedDocuments / documentFields.length) * documentWeight;

  const totalScore = Math.round((requiredScore + optionalScore + documentScore) * 100);

  return {
    score: Math.min(100, Math.max(0, totalScore)),
    missing_fields: missingFields,
    completed_required: completedRequired,
    total_required: requiredFields.length,
    completed_optional: completedOptional,
    total_optional: optionalFields.length,
    completed_documents: completedDocuments,
    total_documents: documentFields.length
  };
}

function identifyDuplicateUsers(db) {
  const emailMap = new Map();
  const duplicates = [];

  db.users.forEach(user => {
    const email = user.email.toLowerCase().trim();
    if (emailMap.has(email)) {
      duplicates.push({
        email,
        users: [emailMap.get(email), user]
      });
    } else {
      emailMap.set(email, user);
    }
  });

  return duplicates;
}

function mergeDuplicateUsers(db, duplicates) {
  const usersToRemove = new Set();
  const profilesToUpdate = [];

  duplicates.forEach(duplicate => {
    const { users } = duplicate;
    // Keep the most recent user (based on created_at or user_id)
    const primaryUser = users.reduce((latest, current) => {
      if (!latest) return current;
      const latestDate = new Date(latest.created_at || '1970-01-01');
      const currentDate = new Date(current.created_at || '1970-01-01');
      return currentDate > latestDate ? current : latest;
    }, null);

    const secondaryUser = users.find(u => u.user_id !== primaryUser.user_id);
    
    if (secondaryUser) {
      usersToRemove.add(secondaryUser.user_id);
      
      // Update associated profiles to point to primary user
      const associatedProfiles = db.founder_profiles.filter(p => p.user_id === secondaryUser.user_id);
      associatedProfiles.forEach(profile => {
        profile.user_id = primaryUser.user_id;
        profilesToUpdate.push(profile);
      });

      // Update associated applications
      const associatedApplications = db.applications.filter(a => a.user_id === secondaryUser.user_id);
      associatedApplications.forEach(app => {
        app.user_id = primaryUser.user_id;
      });

      // Update associated drafts
      const associatedDrafts = db.drafts.filter(d => d.user_id === secondaryUser.user_id);
      associatedDrafts.forEach(draft => {
        draft.user_id = primaryUser.user_id;
      });

      console.log(`🔄 Merged user ${secondaryUser.name} (${secondaryUser.email}) into ${primaryUser.name} (${primaryUser.email})`);
    }
  });

  // Remove duplicate users
  db.users = db.users.filter(user => !usersToRemove.has(user.user_id));
  
  return { usersRemoved: usersToRemove.size, profilesUpdated: profilesToUpdate.length };
}

function cleanupOpportunities(db) {
  let removedCount = 0;
  const now = new Date();
  
  db.opportunities = db.opportunities.filter(opp => {
    // Remove opportunities without basic required fields
    if (!opp.title || !opp.opportunity_id || !opp.provider) {
      removedCount++;
      return false;
    }

    // Remove expired opportunities (older than 30 days past deadline)
    if (opp.deadline && opp.deadline !== 'Rolling' && opp.deadline !== 'Variable') {
      const deadlineDate = new Date(opp.deadline);
      if (!isNaN(deadlineDate)) {
        const daysPastDeadline = Math.floor((now - deadlineDate) / (1000 * 60 * 60 * 24));
        if (daysPastDeadline > 30) {
          removedCount++;
          return false;
        }
      }
    }

    return true;
  });

  return removedCount;
}

function main() {
  console.log('🧹 Starting data cleanup...');
  
  try {
    const db = readDB();
    let changesMade = false;

    // 1. Identify and merge duplicate users
    console.log('\n👥 Checking for duplicate users...');
    const duplicates = identifyDuplicateUsers(db);
    if (duplicates.length > 0) {
      console.log(`Found ${duplicates.length} duplicate user groups`);
      const mergeResult = mergeDuplicateUsers(db, duplicates);
      console.log(`✅ Merged ${mergeResult.usersRemoved} duplicate users, updated ${mergeResult.profilesUpdated} profiles`);
      changesMade = true;
    } else {
      console.log('✅ No duplicate users found');
    }

    // 2. Calculate profile completion for all founder profiles
    console.log('\n📊 Calculating profile completion scores...');
    let profilesUpdated = 0;
    db.founder_profiles.forEach(profile => {
      const completion = calculateProfileCompletion(profile);
      if (!profile.profile_completion || profile.profile_completion.score !== completion.score) {
        profile.profile_completion = completion;
        profilesUpdated++;
      }
    });
    console.log(`✅ Updated completion scores for ${profilesUpdated} profiles`);
    if (profilesUpdated > 0) changesMade = true;

    // 3. Clean up opportunities
    console.log('\n🧹 Cleaning up opportunities...');
    const removedOpportunities = cleanupOpportunities(db);
    if (removedOpportunities > 0) {
      console.log(`✅ Removed ${removedOpportunities} invalid/expired opportunities`);
      changesMade = true;
    } else {
      console.log('✅ All opportunities are valid');
    }

    // 4. Ensure all arrays exist
    if (!db.applications) db.applications = [];
    if (!db.drafts) db.drafts = [];
    if (!db.saved_opportunities) db.saved_opportunities = [];
    if (!db.extension_sessions) db.extension_sessions = [];

    // Save changes
    if (changesMade) {
      writeDB(db);
      console.log('\n💾 Data cleanup completed and saved!');
    } else {
      console.log('\n✅ No cleanup needed - data is already clean');
    }

    // Print summary
    console.log('\n📈 Database Summary:');
    console.log(`- Users: ${db.users.length}`);
    console.log(`- Founder Profiles: ${db.founder_profiles.length}`);
    console.log(`- Opportunities: ${db.opportunities.length}`);
    console.log(`- Applications: ${db.applications.length}`);
    console.log(`- Drafts: ${db.drafts.length}`);

  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { calculateProfileCompletion, identifyDuplicateUsers, mergeDuplicateUsers, cleanupOpportunities };
