require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const logger = require('./utils/logger');
const { scrapeStartupGrants, scrapeDetails } = require('./services/scraper');
const { cleanWithAI, formatDetailedContent } = require('./services/aiCleaner');
const { callOpenRouter } = require('./utils/ai');
const { extractTextFromPDF } = require('./utils/pdf');
const { extractJSON } = require('./utils/jsonSanitizer');
const {
  normalizeSchema,
  flattenSchema,
  buildInitialFormFields,
  calculateCompletion,
  inferSchemaFromOpportunity
} = require('./utils/formDrafts');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Verify AI keys on startup
const { getGroqKey, getOpenRouterKey } = require('./utils/ai');
const groqKey = getGroqKey();
const orKey = getOpenRouterKey();
if (!groqKey && !orKey) {
  console.warn('⚠️  WARNING: No AI API keys found in key.txt. AI features will be disabled.');
} else {
  console.log(`✅ AI System: ${groqKey ? 'Groq ' : ''}${orKey ? 'OpenRouter ' : ''}keys detected.`);
}

// Middleware
app.use(cors());

// EMERGENCY DEBUG: Log raw body string to see why body-parser is failing
app.use((req, res, next) => {
  if (req.method === 'POST') {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (data.length > 0 && req.url.includes('match-opportunities')) {
        console.log('📦 RAW INCOMING BODY:', data.substring(0, 100) + (data.length > 100 ? '...' : ''));
      }
    });
  }
  next();
});

app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  
  // Log request start
  logger.debug(`Request started: ${req.method} ${req.path}`, {
    method: req.method,
    path: req.path,
    ip: req.ip,
    user_agent: req.get('User-Agent')
  });
  
  // Override res.end to log response
  const originalEnd = res.end;
  res.end = function(chunk, encoding) {
    const responseTime = Date.now() - startTime;
    const userId = req.user_id || (req.body && req.body.user_id) || 'anonymous';
    
    logger.apiRequest(
      req.method,
      req.path,
      userId,
      res.statusCode,
      responseTime,
      res.statusCode >= 400 ? new Error(`HTTP ${res.statusCode}`) : null
    );
    
    originalEnd.call(this, chunk, encoding);
  };
  
  next();
});

// Catch-all solution for JSON parse errors (avoids crashes on malformed arrivals)
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.warn('Malformed JSON request detected', {
      path: req.path,
      method: req.method,
      ip: req.ip
    });
    return res.status(400).send({ error: 'Invalid JSON format' });
  }
  next();
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error in request', err, {
    path: req.path,
    method: req.method,
    user_id: req.user_id || 'anonymous',
    ip: req.ip
  });
  
  // Don't leak error details in production
  const isDevelopment = process.env.NODE_ENV === 'development';
  const errorResponse = {
    error: isDevelopment ? err.message : 'Internal server error',
    ...(isDevelopment && { stack: err.stack })
  };
  
  res.status(err.status || 500).json(errorResponse);
});

// Multer storage for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// Separate multer for memory-only (AI generation)
const memoryUpload = multer({ storage: multer.memoryStorage() });

// ─── DB Helpers ───────────────────────────────────────────────────────────────
function readDB() {
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function getHostMetadata(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const parts = parsed.hostname.split('.').filter(Boolean);
    const root_domain = parts.length >= 2 ? parts.slice(-2).join('.') : parsed.hostname;
    return {
      hostname: parsed.hostname,
      root_domain
    };
  } catch (err) {
    return {
      hostname: '',
      root_domain: ''
    };
  }
}

function findOpportunity(db, opportunityId) {
  return db.opportunities.find(o => o.opportunity_id === opportunityId || o.slug === opportunityId);
}

function getDefaultRequiredDocumentStatus(requiredDocuments = []) {
  return requiredDocuments.reduce((acc, doc) => {
    acc[doc] = 'missing';
    return acc;
  }, {});
}

function upsertDraft({
  db,
  user_id,
  opportunity_id,
  schema,
  source_url = '',
  schema_source = 'manual',
  capture_meta = {}
}) {
  const normalizedSchema = normalizeSchema(schema);
  const existing = db.drafts.find(d => d.user_id === user_id && d.opportunity_id === opportunity_id);
  const existingFields = existing ? existing.form_fields : {};
  const mergedFields = buildInitialFormFields(normalizedSchema, existingFields);
  const completion = calculateCompletion(normalizedSchema, mergedFields);
  const requiredDocumentsStatus = existing?.required_documents_status || getDefaultRequiredDocumentStatus(normalizedSchema.required_documents);

  const baseDraft = existing || {
    draft_id: 'd' + uuidv4().slice(0, 6),
    user_id,
    opportunity_id,
    created_at: new Date().toISOString(),
    status: 'draft'
  };

  Object.assign(baseDraft, {
    title: normalizedSchema.title,
    subtitle: normalizedSchema.subtitle,
    form_schema: normalizedSchema,
    form_fields: mergedFields,
    completion,
    required_documents_status: requiredDocumentsStatus,
    schema_source,
    source_url,
    capture_meta,
    last_saved: new Date().toISOString()
  });

  if (!existing) {
    db.drafts.push(baseDraft);
  }

  return baseDraft;
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

// POST /api/signup
app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });

    const db = readDB();
    const existing = db.users.find(u => u.email === email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    // Hash password securely
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const user = {
      user_id: 'u' + uuidv4().slice(0, 6),
      name,
      email,
      password: hashedPassword, // Secure hashed password
      role: role || 'founder',
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=0ea5e9&color=fff&size=32`,
      created_at: new Date().toISOString().slice(0, 10)
    };

    db.users.push(user);
    writeDB(db);

    const { password: _, ...safeUser } = user;
    res.status(201).json({ message: 'Account created', user: safeUser });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Internal server error during signup' });
  }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const db = readDB();
    const user = db.users.find(u => u.email === email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    // For backward compatibility with existing plain text passwords
    let isValidPassword = false;
    if (user.password.startsWith('$2b$') || user.password.startsWith('$2a$')) {
      // Hashed password - verify with bcrypt
      isValidPassword = await bcrypt.compare(password, user.password);
    } else {
      // Plain text password (existing users) - compare directly
      isValidPassword = password === user.password;
      // Optionally migrate to hashed password
      if (isValidPassword) {
        const saltRounds = 12;
        user.password = await bcrypt.hash(password, saltRounds);
        writeDB(db);
      }
    }

    if (!isValidPassword) return res.status(401).json({ error: 'Invalid credentials' });

    const { password: _, ...safeUser } = user;
    res.json({ message: 'Login successful', user: safeUser });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

// GET /api/users/check-email
app.get('/api/users/check-email', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email query parameter is required' });

  const db = readDB();
  const existing = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  res.json({ exists: !!existing });
});


// ─── FILE UPLOAD ──────────────────────────────────────────────────────────────

// POST /api/upload
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { user_id, doc_type, application_id } = req.body;

    const db = readDB();
    let documentRecord = {
      document_id: 'doc_' + uuidv4().slice(0, 8),
      filename: req.file.filename,
      original_name: req.file.originalname,
      file_size: req.file.size,
      mime_type: req.file.mimetype,
      uploaded_at: new Date().toISOString(),
      user_id,
      doc_type
    };

    // Upload to founder profile
    if (user_id && doc_type) {
      const profile = db.founder_profiles.find(p => p.user_id === user_id);
      if (profile) {
        if (!profile.documents) profile.documents = {};
        profile.documents[doc_type] = req.file.filename;
        
        // Track document in separate collection for better management
        if (!db.documents) db.documents = [];
        db.documents.push(documentRecord);
        
        writeDB(db);
        logger.info('Document uploaded to profile', { user_id, doc_type, filename: req.file.filename });
      }
    }

    // Upload to application if specified
    if (application_id) {
      const application = db.applications.find(a => a.application_id === application_id);
      if (application) {
        if (!application.documents) application.documents = [];
        
        const appDocument = {
          ...documentRecord,
          application_id,
          uploaded_for: 'application'
        };
        
        application.documents.push(appDocument);
        db.documents.push(appDocument);
        writeDB(db);
        
        logger.info('Document uploaded to application', { 
          user_id, 
          application_id, 
          doc_type, 
          filename: req.file.filename 
        });
      }
    }

    res.json({ 
      message: 'File uploaded successfully', 
      document: documentRecord,
      path: `/uploads/${req.file.filename}` 
    });
  } catch (error) {
    logger.error('File upload failed', error, { user_id: req.body.user_id });
    res.status(500).json({ error: 'File upload failed' });
  }
});

// GET /api/documents?user_id=&application_id=
app.get('/api/documents', (req, res) => {
  try {
    const { user_id, application_id } = req.query;
    
    if (!user_id && !application_id) {
      return res.status(400).json({ error: 'user_id or application_id is required' });
    }

    const db = readDB();
    let documents = db.documents || [];

    if (user_id) {
      documents = documents.filter(doc => doc.user_id === user_id && doc.uploaded_for !== 'application');
    } else if (application_id) {
      documents = documents.filter(doc => doc.application_id === application_id);
    }

    res.json(documents);
  } catch (error) {
    logger.error('Failed to fetch documents', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// DELETE /api/documents/:document_id
app.delete('/api/documents/:document_id', (req, res) => {
  try {
    const { document_id } = req.params;
    const db = readDB();
    
    const documentIndex = db.documents.findIndex(doc => doc.document_id === document_id);
    if (documentIndex === -1) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const document = db.documents[documentIndex];
    
    // Remove file from filesystem
    const filePath = path.join(UPLOADS_DIR, document.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Remove from database
    db.documents.splice(documentIndex, 1);
    
    // Update profile references
    if (document.uploaded_for !== 'application') {
      const profile = db.founder_profiles.find(p => p.user_id === document.user_id);
      if (profile && profile.documents && profile.documents[document.doc_type] === document.filename) {
        delete profile.documents[document.doc_type];
      }
    }

    writeDB(db);
    logger.info('Document deleted', { document_id, user_id: document.user_id });
    
    res.json({ message: 'Document deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete document', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// ─── FOUNDER PROFILE ─────────────────────────────────────────────────────────

// GET /api/founder/profile?user_id=
app.get('/api/founder/profile', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const db = readDB();
  const profile = db.founder_profiles.find(p => p.user_id === user_id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  res.json(profile);
});

// POST /api/founder/profile — create
app.post('/api/founder/profile', (req, res) => {
  const { user_id, ...fields } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const db = readDB();
  const existing = db.founder_profiles.find(p => p.user_id === user_id);
  if (existing) return res.status(409).json({ error: 'Profile already exists. Use PUT to update.' });

  const profile = {
    founder_id: 'f' + uuidv4().slice(0, 6),
    user_id,
    startup_name: fields.startup_name || '',
    sector: fields.sector || '',
    stage: fields.stage || '',
    startup_overview: fields.startup_overview || '',
    website: fields.website || '',
    application_email: fields.application_email || '',
    problem_statement: fields.problem_statement || '',
    solution_summary: fields.solution_summary || '',
    target_customers: fields.target_customers || '',
    business_model: fields.business_model || '',
    team_size: fields.team_size || 0,
    founded_year: fields.founded_year || new Date().getFullYear(),
    location: fields.location || '',
    documents: { pitch_deck: null, financial_projections: null, letters_of_support: null, budget_breakdown: null },
    profile_completion: { score: 0, missing_fields: [] }
  };

  db.founder_profiles.push(profile);
  writeDB(db);
  res.status(201).json(profile);
});

// PUT /api/founder/profile — update
app.put('/api/founder/profile', (req, res) => {
  const { user_id, ...fields } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const db = readDB();
  const profile = db.founder_profiles.find(p => p.user_id === user_id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  Object.assign(profile, fields);
  writeDB(db);
  res.json(profile);
});

// ─── OPPORTUNITIES ────────────────────────────────────────────────────────────

// GET /api/opportunities?type=
app.get('/api/opportunities', (req, res) => {
  const { type } = req.query;
  const db = readDB();
  let opps = db.opportunities;
  if (type) opps = opps.filter(o => o.type === type);
  res.json(opps);
});

// GET /api/opportunities/:id/details
app.get('/api/opportunities/:id/details', async (req, res) => {
  const db = readDB();
  const index = db.opportunities.findIndex(o => o.opportunity_id === req.params.id || o.slug === req.params.id);
  const opp = db.opportunities[index];

  if (!opp) return res.status(404).json({ error: 'Opportunity not found' });

  // Return cached formatted data if it exists
  if (opp.formatted_details) {
    return res.json({ formatted: opp.formatted_details, raw: opp.raw_scraped_text || '--' });
  }

  if (!opp.link) return res.status(400).json({ error: 'No link available to scrape' });

  try {
    const raw = await scrapeDetails(opp.link);
    // Cache the raw text for future formatting
    opp.raw_scraped_text = raw;
    writeDB(db);
    res.json({ raw });
  } catch (err) {
    res.status(500).json({ error: 'Failed to scrape details: ' + err.message });
  }
});

// POST /api/ai/format-details
// Manually triggers the AI formatter for raw text and CACHES it
app.post('/api/ai/format-details', async (req, res) => {
  const { opportunity_id, raw_text } = req.body;
  console.log(`AI System: Formatting details for opportunity: ${opportunity_id}`);
  
  if (!raw_text || raw_text.trim().length < 10) {
    console.warn('AI System: Empty raw text received for formatting');
    return res.status(400).json({ error: 'raw_text is required and must be substantial' });
  }

  try {
    // Add protective throttle for free tier
    await new Promise(r => setTimeout(r, 2000));

    console.log('✨ AI System: Calling formatDetailedContent...');
    const formatted = await formatDetailedContent(raw_text);
    console.log('✅ AI System: Formatting complete.');

    // If ID provided, cache the result
    if (opportunity_id) {
      const db = readDB();
      const opp = db.opportunities.find(o => o.opportunity_id === opportunity_id);
      if (opp) {
        opp.formatted_details = formatted;
        writeDB(db);
        console.log(`💾 AI System: Cached formatted details for ${opportunity_id}`);
      }
    }

    res.json({ result: formatted });
  } catch (err) {
    console.error('❌ AI System: Error formatting details:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/opportunities/:id
app.get('/api/opportunities/:id', (req, res) => {
  const db = readDB();
  const opp = db.opportunities.find(o => o.opportunity_id === req.params.id || o.slug === req.params.id);
  if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
  res.json(opp);
});

// ─── SCRAPING BACKGROUND WORKER (PRODUCTION) ─────────────────────────────────

const { cleanListingItem } = require('./services/aiCleaner');

let _scraperStatus = { running: false, lastRun: null, lastResult: null };

function saveScrapedToDB(newData) {
  const db = readDB();
  const now = new Date();

  // IDs with active user data — never delete these
  const appliedIds = new Set(db.applications.map(a => a.opportunity_id));
  const savedIds = new Set(db.saved_opportunities.map(s => s.opportunity_id));
  const draftIds = new Set(db.drafts.map(d => d.opportunity_id));
  const protectedIds = new Set([...appliedIds, ...savedIds, ...draftIds]);

  // Build slug index for fast dedup
  const existingSlugs = new Map();
  db.opportunities.forEach(o => {
    if (o.slug) existingSlugs.set(o.slug, o);
    if (o.link) existingSlugs.set(o.link, o);
  });

  // 1. Clean expired scraped entries — keep manual and user-linked ones
  db.opportunities = db.opportunities.filter(o => {
    if (!o.opportunity_id.startsWith('opp_')) return true;
    if (protectedIds.has(o.opportunity_id)) return true;

    // Deadline expiry
    if (o.deadline && o.deadline !== 'Rolling' && o.deadline !== 'Variable') {
      const deadlineDate = new Date(o.deadline);
      if (!isNaN(deadlineDate) && deadlineDate < now) return false;
    }

    // Stale: not seen in 7 days (was 3 — too aggressive for paginated scraping)
    if (o.last_seen_at) {
      const diffDays = Math.ceil((now - new Date(o.last_seen_at)) / (1000 * 60 * 60 * 24));
      if (diffDays > 7) return false;
    }

    return true;
  });

  // 2. Merge: update existing or insert new
  let addedCount = 0;
  let updatedCount = 0;

  for (const item of newData) {
    const existing = existingSlugs.get(item.slug) || existingSlugs.get(item.link);

    if (existing) {
      // Refresh metadata on existing entry
      existing.title = item.title || existing.title;
      existing.description = item.description || existing.description;
      existing.provider = item.provider || existing.provider;
      existing.type = item.type || existing.type;
      existing.stage = item.stage || existing.stage;
      existing.sector = item.sector || existing.sector;
      existing.location = item.location || existing.location;
      if (item.amount && item.amount !== 'Variable') existing.amount = item.amount;
      if (item.deadline && item.deadline !== 'Rolling') existing.deadline = item.deadline;
      existing.last_seen_at = now.toISOString();
      updatedCount++;
    } else {
      // Insert new opportunity
      const opp = {
        opportunity_id: 'opp_' + uuidv4().slice(0, 6),
        title: item.title,
        provider: item.provider || 'Startup Grants India',
        description: item.description || item.title,
        eligibility: 'See opportunity page for detailed eligibility criteria.',
        type: item.type || 'Grant',
        amount: item.amount || 'Variable',
        deadline: item.deadline || 'Rolling',
        location: item.location || 'India',
        sector: item.sector || 'All Sectors',
        stage: item.stage || '',
        link: item.link,
        slug: item.slug || '',
        credibility_source: 'Verified via StartupGrantsIndia.com',
        match_score: 0,
        scraped_at: now.toISOString(),
        last_seen_at: now.toISOString(),
      };
      db.opportunities.push(opp);
      existingSlugs.set(item.slug, opp);
      existingSlugs.set(item.link, opp);
      addedCount++;
    }
  }

  writeDB(db);
  return { added: addedCount, updated: updatedCount, total: db.opportunities.length };
}

async function runScraper() {
  if (_scraperStatus.running) {
    console.warn('⚠️  Scraper is already running. Skipping.');
    return _scraperStatus;
  }

  _scraperStatus.running = true;
  const startTime = Date.now();
  console.log('\n🚀 ═══════════════════════════════════════════════════════════');
  console.log('   PRODUCTION SCRAPER — StartupGrantsIndia.com');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    // Phase 1: Scrape listings (multi-page, no AI needed)
    const rawItems = await scrapeStartupGrants();
    console.log(`\n📦 Scraped ${rawItems.length} total listings from site.`);

    // Phase 2: Clean and enrich (local inference, no API calls)
    const cleaned = rawItems
      .filter(item => item.title && item.title.length >= 5)
      .map(item => cleanListingItem(item));

    console.log(`🧹 Cleaned ${cleaned.length} valid opportunities.`);

    // Phase 3: Merge into database
    const result = saveScrapedToDB(cleaned);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Scraper complete in ${elapsed}s`);
    console.log(`   📊 Added: ${result.added} | Updated: ${result.updated} | Total in DB: ${result.total}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    _scraperStatus = {
      running: false,
      lastRun: new Date().toISOString(),
      lastResult: { ...result, elapsed_seconds: parseFloat(elapsed), raw_scraped: rawItems.length },
    };

    return _scraperStatus;
  } catch (err) {
    console.error('❌ Scraper worker error:', err);
    _scraperStatus.running = false;
    _scraperStatus.lastResult = { error: err.message };
    return _scraperStatus;
  }
}

// Trigger scraper manually — returns detailed stats
app.get('/api/trigger-scraper', async (req, res) => {
  console.log('🔧 Manual scraper trigger via API…');
  const status = await runScraper();
  res.json({
    message: 'Scraping complete',
    ...status,
  });
});

// Get scraper status without triggering
app.get('/api/scraper-status', (req, res) => {
  const db = readDB();
  res.json({
    ..._scraperStatus,
    opportunities_in_db: db.opportunities.length,
  });
});

// Cron: every 6 hours
cron.schedule('0 */6 * * *', async () => {
  console.log('⏰ Auto scraping started by Cron…');
  await runScraper();
});


// ─── SAVED OPPORTUNITIES ──────────────────────────────────────────────────────

// GET /api/saved?user_id=
app.get('/api/saved', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const db = readDB();
  const saved = db.saved_opportunities.filter(s => s.user_id === user_id);

  // Enrich with opportunity data
  const enriched = saved.map(s => {
    const opp = db.opportunities.find(o => o.opportunity_id === s.opportunity_id);
    return { ...s, opportunity: opp || null };
  });

  res.json(enriched);
});

// POST /api/saved
app.post('/api/saved', (req, res) => {
  const { user_id, opportunity_id } = req.body;
  if (!user_id || !opportunity_id) return res.status(400).json({ error: 'user_id and opportunity_id are required' });

  const db = readDB();
  const already = db.saved_opportunities.find(s => s.user_id === user_id && s.opportunity_id === opportunity_id);
  if (already) return res.status(409).json({ error: 'Already saved' });

  const saved = {
    saved_id: 's' + uuidv4().slice(0, 6),
    user_id,
    opportunity_id,
    saved_date: new Date().toISOString().slice(0, 10)
  };

  db.saved_opportunities.push(saved);
  writeDB(db);
  res.status(201).json(saved);
});

// DELETE /api/saved (by query params)
app.delete('/api/saved', (req, res) => {
  const { user_id, opportunity_id } = req.query;
  if (!user_id || !opportunity_id) return res.status(400).json({ error: 'user_id and opportunity_id are required' });

  const db = readDB();
  const index = db.saved_opportunities.findIndex(s => s.user_id === user_id && s.opportunity_id === opportunity_id);
  if (index === -1) return res.status(404).json({ error: 'Saved item not found' });

  db.saved_opportunities.splice(index, 1);
  writeDB(db);

  res.json({ message: 'Opportunity unsaved' });
});

// DELETE /api/saved/:id
app.delete('/api/saved/:id', (req, res) => {
  const db = readDB();
  const idx = db.saved_opportunities.findIndex(s => s.saved_id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Saved item not found' });

  db.saved_opportunities.splice(idx, 1);
  writeDB(db);
  res.json({ message: 'Removed from saved' });
});

// ─── APPLICATIONS ─────────────────────────────────────────────────────────────

// GET /api/applications?user_id=
app.get('/api/applications', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const db = readDB();
  const apps = db.applications.filter(a => a.user_id === user_id);

  // Enrich with opportunity data
  const enriched = apps.map(a => {
    const opp = db.opportunities.find(o => o.opportunity_id === a.opportunity_id);
    return { ...a, opportunity: opp || null };
  });

  res.json(enriched);
});

// GET /api/applications/:id
app.get('/api/applications/:id', (req, res) => {
  const db = readDB();
  const app_ = db.applications.find(a => a.application_id === req.params.id);
  if (!app_) return res.status(404).json({ error: 'Application not found' });

  const opp = db.opportunities.find(o => o.opportunity_id === app_.opportunity_id);
  res.json({ ...app_, opportunity: opp || null });
});

// POST /api/applications — create new application
app.post('/api/applications', (req, res) => {
  const { user_id, opportunity_id } = req.body;
  if (!user_id || !opportunity_id) return res.status(400).json({ error: 'user_id and opportunity_id are required' });

  const db = readDB();
  const existing = db.applications.find(a => a.user_id === user_id && a.opportunity_id === opportunity_id);
  if (existing) return res.status(409).json({ error: 'Application already exists for this opportunity' });

  const application = {
    application_id: 'a' + uuidv4().slice(0, 6),
    user_id,
    opportunity_id,
    status: 'Applied',
    timeline: [{ stage: 'Applied', date: new Date().toISOString().slice(0, 10) }],
    next_step: null,
    feedback: null,
    ai_insights: [],
    submitted_at: new Date().toISOString().slice(0, 10),
    deadline: req.body.deadline || null
  };

  db.applications.push(application);
  writeDB(db);
  res.status(201).json(application);
});

// PUT /api/applications/:id — update status / next step / feedback
app.put('/api/applications/:id', (req, res) => {
  const db = readDB();
  const application = db.applications.find(a => a.application_id === req.params.id);
  if (!application) return res.status(404).json({ error: 'Application not found' });

  const { status, next_step, feedback } = req.body;

  if (status && status !== application.status) {
    application.status = status;
    application.timeline.push({ stage: status, date: new Date().toISOString().slice(0, 10) });
    
    // Auto-generate next steps based on status progression
    application.next_step = getNextStep(status);
  }
  if (next_step !== undefined) application.next_step = next_step;
  if (feedback !== undefined) application.feedback = feedback;

  writeDB(db);
  res.json(application);
});

// GET /api/applications/deadline-reminders?user_id=
app.get('/api/applications/deadline-reminders', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const db = readDB();
  const applications = db.applications.filter(a => a.user_id === user_id);
  const reminders = [];

  applications.forEach(app => {
    const opportunity = db.opportunities.find(o => o.opportunity_id === app.opportunity_id);
    if (!opportunity || !opportunity.deadline || opportunity.deadline === 'Rolling') return;

    const deadlineDate = new Date(opportunity.deadline);
    if (isNaN(deadlineDate)) return;

    const today = new Date();
    const daysUntilDeadline = Math.ceil((deadlineDate - today) / (1000 * 60 * 60 * 24));

    if (daysUntilDeadline <= 7 && daysUntilDeadline >= 0) {
      reminders.push({
        application_id: app.application_id,
        opportunity_title: opportunity.title,
        deadline: opportunity.deadline,
        days_until_deadline: daysUntilDeadline,
        urgency: daysUntilDeadline <= 3 ? 'high' : daysUntilDeadline <= 5 ? 'medium' : 'low',
        status: app.status
      });
    }
  });

  reminders.sort((a, b) => a.days_until_deadline - b.days_until_deadline);
  res.json(reminders);
});

// GET /api/applications/analytics?user_id=
app.get('/api/applications/analytics', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const db = readDB();
  const applications = db.applications.filter(a => a.user_id === user_id);

  const analytics = {
    total_applications: applications.length,
    status_breakdown: {},
    monthly_submissions: {},
    success_rate: 0,
    average_response_time: 0
  };

  applications.forEach(app => {
    // Status breakdown
    analytics.status_breakdown[app.status] = (analytics.status_breakdown[app.status] || 0) + 1;

    // Monthly submissions
    const month = app.submitted_at?.slice(0, 7) || 'unknown';
    analytics.monthly_submissions[month] = (analytics.monthly_submissions[month] || 0) + 1;
  });

  // Calculate success rate
  const successful = (analytics.status_breakdown['Accepted'] || 0) + (analytics.status_breakdown['Shortlisted'] || 0);
  analytics.success_rate = applications.length > 0 ? Math.round((successful / applications.length) * 100) : 0;

  res.json(analytics);
});

// Helper function for status progression
function getNextStep(currentStatus) {
  const statusFlow = {
    'Applied': 'Wait for confirmation email',
    'Under Review': 'Prepare for potential interview',
    'Shortlisted': 'Schedule interview/pitch preparation',
    'Interview / Pitch Round': 'Follow up within 1 week',
    'Accepted': 'Complete onboarding requirements',
    'Rejected': 'Review feedback and improve next application'
  };
  
  return statusFlow[currentStatus] || 'Check application portal for updates';
}

// ─── DRAFTS ───────────────────────────────────────────────────────────────────

// GET /api/drafts?user_id= — all drafts for user
app.get('/api/drafts', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const db = readDB();
  const drafts = db.drafts.filter(d => d.user_id === user_id);

  // Enrich with opportunity data
  const enriched = drafts.map(d => {
    const opp = db.opportunities.find(o => o.opportunity_id === d.opportunity_id);
    return { ...d, opportunity: opp || null };
  });

  res.json(enriched);
});

// GET /api/drafts/by-opportunity?user_id=&opportunity_id=
app.get('/api/drafts/by-opportunity', (req, res) => {
  const { user_id, opportunity_id } = req.query;
  if (!user_id || !opportunity_id) {
    return res.status(400).json({ error: 'user_id and opportunity_id are required' });
  }

  const db = readDB();
  const draft = db.drafts.find(d => d.user_id === user_id && d.opportunity_id === opportunity_id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const opp = findOpportunity(db, opportunity_id);
  res.json({ ...draft, opportunity: opp || null });
});

// POST /api/drafts/bootstrap
app.post('/api/drafts/bootstrap', (req, res) => {
  const {
    user_id,
    opportunity_id,
    source_url = '',
    form_schema,
    schema_source = 'manual',
    capture_meta = {}
  } = req.body || {};

  if (!user_id || !opportunity_id) {
    return res.status(400).json({ error: 'user_id and opportunity_id are required' });
  }

  const db = readDB();
  const opportunity = findOpportunity(db, opportunity_id);
  if (!opportunity) return res.status(404).json({ error: 'Opportunity not found' });

  const schemaToUse = form_schema || opportunity.generated_application_schema || inferSchemaFromOpportunity(opportunity);
  const draft = upsertDraft({
    db,
    user_id,
    opportunity_id,
    schema: schemaToUse,
    source_url,
    schema_source,
    capture_meta
  });

  writeDB(db);
  res.status(201).json({ ...draft, opportunity });
});

// GET /api/drafts/:id
app.get('/api/drafts/:id', (req, res) => {
  const db = readDB();
  const draft = db.drafts.find(d => d.draft_id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const opp = db.opportunities.find(o => o.opportunity_id === draft.opportunity_id);
  res.json({ ...draft, opportunity: opp || null });
});

// PUT /api/drafts/:id — update draft fields
app.put('/api/drafts/:id', (req, res) => {
  const db = readDB();
  const draft = db.drafts.find(d => d.draft_id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const { form_fields, required_documents_status, form_schema, source_url, schema_source, capture_meta } = req.body;

  if (form_schema) {
    draft.form_schema = normalizeSchema(form_schema, draft.title || 'Smart Application Draft');
    draft.form_fields = buildInitialFormFields(draft.form_schema, { ...draft.form_fields, ...(form_fields || {}) });
  }

  if (form_fields) {
    Object.assign(draft.form_fields, form_fields);
  }

  if (required_documents_status) {
    Object.assign(draft.required_documents_status, required_documents_status);
  }

  if (source_url !== undefined) draft.source_url = source_url;
  if (schema_source !== undefined) draft.schema_source = schema_source;
  if (capture_meta !== undefined) draft.capture_meta = capture_meta;

  draft.completion = calculateCompletion(draft.form_schema || {}, draft.form_fields || {});
  draft.last_saved = new Date().toISOString();
  writeDB(db);
  res.json(draft);
});

// POST /api/extension/session
app.post('/api/extension/session', (req, res) => {
  const { user_id, opportunity_id, external_url } = req.body || {};
  if (!user_id || !opportunity_id || !external_url) {
    return res.status(400).json({ error: 'user_id, opportunity_id and external_url are required' });
  }

  const db = readDB();
  if (!db.extension_sessions) db.extension_sessions = [];

  const hostMeta = getHostMetadata(external_url);
  const session = {
    session_id: 'x' + uuidv4().slice(0, 6),
    user_id,
    opportunity_id,
    external_url,
    hostname: hostMeta.hostname,
    root_domain: hostMeta.root_domain,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.extension_sessions = db.extension_sessions
    .filter(item => item.external_url !== external_url || item.user_id !== user_id || item.opportunity_id !== opportunity_id);
  db.extension_sessions.unshift(session);
  db.extension_sessions = db.extension_sessions.slice(0, 25);

  writeDB(db);
  res.status(201).json(session);
});

// GET /api/extension/session?external_url=
app.get('/api/extension/session', (req, res) => {
  const { external_url, user_id, opportunity_id } = req.query;
  if (!external_url && !(user_id && opportunity_id)) {
    return res.status(400).json({ error: 'external_url or user_id + opportunity_id is required' });
  }

  const db = readDB();
  const sessions = db.extension_sessions || [];
  let matches = sessions;

  if (user_id && opportunity_id) {
    matches = matches.filter(item => item.user_id === user_id && item.opportunity_id === opportunity_id);
  }

  if (external_url) {
    const targetMeta = getHostMetadata(external_url);
    matches = matches.filter(item => {
      const sessionHostname = item.hostname || getHostMetadata(item.external_url).hostname;
      const sessionRootDomain = item.root_domain || getHostMetadata(item.external_url).root_domain;
      return sessionHostname === targetMeta.hostname || (sessionRootDomain && sessionRootDomain === targetMeta.root_domain);
    });
  }

  matches.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
  const match = matches[0];

  if (!match) return res.status(404).json({ error: 'No staged extension session found for this site' });
  res.json(match);
});

// ─── USER SETTINGS ────────────────────────────────────────────────────────────

// GET /api/user?user_id=
app.get('/api/user', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const db = readDB();
  const user = db.users.find(u => u.user_id === user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { password: _, ...safeUser } = user;
  res.json(safeUser);
});

// PUT /api/user — update user settings
app.put('/api/user', (req, res) => {
  const { user_id, ...fields } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const db = readDB();
  const user = db.users.find(u => u.user_id === user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Allow updating name, email (but not user_id, role, created_at)
  const allowed = ['name', 'email', 'password', 'avatar'];
  allowed.forEach(k => { if (fields[k] !== undefined) user[k] = fields[k]; });

  writeDB(db);
  const { password: _, ...safeUser } = user;
  res.json(safeUser);
});

// ─── AI INTEGRATION (OPENROUTER) ──────────────────────────────────────────────

// POST /api/ai/generate-profile
// Auto-generate: name, sector, stage, description, problem, solution, customers, model
// Supports: startup_overview (text), website (url), and file (PDF upload)
app.post('/api/ai/generate-profile', memoryUpload.single('file'), async (req, res) => {
  try {
    const { startup_overview, website } = req.body;
    let combinedContext = `Manual Overview: ${startup_overview || 'Not provided'}\n`;

    // 1. Optional Website Scraping
    if (website && website.startsWith('http')) {
      console.log(`🌐 Scraping website: ${website}`);
      try {
        const scraped = await scrapeDetails(website);
        if (scraped) combinedContext += `\nWebsite Content:\n${scraped.substring(0, 5000)}\n`;
      } catch (e) {
        console.warn(`Scrape failed for ${website}:`, e.message);
      }
    }

    // 2. Optional PDF Extraction
    if (req.file && req.file.mimetype === 'application/pdf') {
      console.log(`📄 Extracting PDF: ${req.file.originalname}`);
      try {
        const pdfText = await extractTextFromPDF(req.file.buffer);
        if (pdfText) combinedContext += `\nPDF Content (Pitch Deck):\n${pdfText.substring(0, 5000)}\n`;
      } catch (e) {
        console.warn(`PDF extraction failed:`, e.message);
      }
    }

    const prompt = `
      You are an expert startup analyst. Analyze the following context and extract a COMPREHENSIVE startup profile.
      Context:
      ${combinedContext}

      CRITICAL: Return ONLY a valid JSON object. No markdown, no chatter.
      JSON Schema:
      {
        "startup_name": "string",
        "sector": "string",
        "stage": "string",
        "startup_overview": "string (improved description)",
        "problem_statement": "string",
        "solution_summary": "string",
        "target_customers": "string",
        "business_model": "string"
      }

      Use high-quality, professional investor-ready language.
    `;

    console.log(`🤖 Consulting AI for profile generation...`);
    const resultString = await callOpenRouter(prompt);

    // Robust cleaning
    let cleanJson = resultString.match(/\{[\s\S]*\}/);
    if (!cleanJson) throw new Error("AI failed to return valid JSON");

    // Final check for trailing commas etc
    let jsonText = cleanJson[0].replace(/,\s*([\]}])/g, '$1');
    const parsed = JSON.parse(jsonText);

    res.json({ result: parsed });
  } catch (err) {
    console.error("Profile generation error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/generate-application-schema
app.post('/api/ai/generate-application-schema', async (req, res) => {
  try {
    const { opportunity_id, source_url = '' } = req.body || {};
    if (!opportunity_id) return res.status(400).json({ error: 'opportunity_id is required' });

    const db = readDB();
    const opportunity = findOpportunity(db, opportunity_id);
    if (!opportunity) return res.status(404).json({ error: 'Opportunity not found' });

    const detailContext = JSON.stringify({
      title: opportunity.title,
      provider: opportunity.provider,
      description: opportunity.description,
      eligibility: opportunity.eligibility,
      benefits: opportunity.benefits,
      formatted_details: opportunity.formatted_details,
      raw_scraped_text: (opportunity.raw_scraped_text || '').slice(0, 5000),
      source_url: source_url || opportunity.link || ''
    });

    const prompt = `
      You are designing a structured grant application form for a funding opportunity.
      Infer the likely application questions a founder will need to answer.

      Return ONLY valid JSON with this exact structure:
      {
        "title": "string",
        "subtitle": "string",
        "sections": [
          {
            "title": "string",
            "fields": [
              {
                "id": "snake_case_key",
                "label": "Question text",
                "type": "text | textarea | email | url | number | date | select | checkbox",
                "required": true,
                "placeholder": "string",
                "help_text": "string",
                "options": ["choice 1"],
                "max_words": 150
              }
            ]
          }
        ],
        "required_documents": ["Pitch deck"]
      }

      Rules:
      - Prefer realistic founder application fields.
      - Group them into 2-5 sections.
      - Use textarea for narrative questions.
      - Use select only when the likely answer space is short and obvious.
      - Include required_documents when strongly implied.

      Opportunity context:
      ${detailContext}
    `;

    let schema = null;
    try {
        console.log('[AI] Calling LLM...');
        const aiResponse = await callLLM(prompt);
        console.log('[AI] Raw Response Received:', aiResponse?.substring(0, 200) + '...');

        // 3. Extract JSON
        console.log('[AI] Extracting JSON...');
        const result = extractJSON(aiResponse);
        console.log('[AI] Extracted JSON Keys:', Object.keys(result || {}));
        schema = result;
    } catch (err) {
      console.warn('Application schema AI generation failed, using fallback schema.', err.message);
    }

    const normalized = normalizeSchema(schema || inferSchemaFromOpportunity(opportunity), `${opportunity.title} Application Draft`);
    opportunity.generated_application_schema = normalized;

    const matchingDrafts = db.drafts.filter(d => d.opportunity_id === opportunity_id);
    matchingDrafts.forEach(draft => {
      if (!draft.form_schema || draft.schema_source !== 'extension_capture') {
        draft.form_schema = normalized;
        draft.form_fields = buildInitialFormFields(normalized, draft.form_fields || {});
        draft.completion = calculateCompletion(normalized, draft.form_fields);
      }
    });

    writeDB(db);
    res.json({ result: normalized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/feedback-insights
// Analyzes rejection feedback to give actionable advice
app.post('/api/ai/feedback-insights', async (req, res) => {
  try {
    const { application } = req.body;
    if (!application) return res.status(400).json({ error: 'Application data is required' });

    console.log(`🤖 AI System: Generating feedback insights for application ${application.application_id}`);

    const timeline = application.timeline || [];
    const rejectionEvent = timeline.find(t => (t.stage || t.status) === 'Rejected');
    const feedbackText = rejectionEvent?.note || application.feedback || 'No specific feedback provided.';

    const prompt = `
      You are a startup coach and investment analyst. A founder just got rejected from a funding opportunity.
      
      Opportunity: ${application.opportunity?.title || 'Unknown'}
      Rejection Feedback: "${feedbackText}"
      
      Task: Provide a 2-3 sentence "Actionable Insight". 
      - If the feedback is about "traction", suggest specific metrics to focus on.
      - If it's about "market size", suggest how to better articulate the TAM.
      - If it's vague, give general advice on how to follow up or improve the pitch deck.
      
      Keep it encouraging but professional. Start with "Insight:".
      Do not include any other chatter.
    `;

    try {
      const result = await callOpenRouter(prompt);
      const cleaned = result.replace(/^Insight:\s*/i, '').trim();
      res.json({ result: cleaned });
    } catch (err) {
      console.error('AI Insight generation failed', err);
      res.json({ result: "Focus on strengthening your core traction metrics and refining your value proposition for the next round." });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rank opportunities with match score (0-100)
app.post('/api/ai/match-opportunities', async (req, res) => {
  try {
    const { profile, opportunities } = req.body;
    if (!opportunities || !Array.isArray(opportunities) || opportunities.length === 0) {
      return res.json({ result: [] });
    }
    console.log(`✨ Incoming match request for ${opportunities.length} items...`);
    
    // Chunk array to prevent LLM token limits and JSON truncation errors
    const CHUNK_SIZE = 5;
    let allResults = [];
    
    for (let i = 0; i < opportunities.length; i += CHUNK_SIZE) {
      const chunk = opportunities.slice(i, i + CHUNK_SIZE);
      console.log(`🤖 Requesting AI match scores for chunk ${Math.floor(i/CHUNK_SIZE) + 1} (${chunk.length} items)...`);
      
      const prompt = `
        You are a JSON data generator for a matching engine. Evaluate the startup against the list of funding opportunities and output a Match Score (0-100) for each.
        
        DO NOT WRITE ANY CODE OR SCRIPTS. ONLY OUTPUT JSON.
        
        SCORING RULES:
        1. Sector Match (up to 40 points): 
           - If the opportunity's sector is "All Sectors", "Sector Agnostic", or perfectly matches the startup, award 40 points.
           - If it's somewhat related (e.g., HealthTech startup and AI opportunity), award 20 points.
           - If completely unrelated, award 0 points.
        2. Stage Match (up to 30 points):
           - If the startup's stage aligns with the opportunity's stage, award 30 points.
           - If the opportunity is flexible or doesn't specify a stage, award 20 points.
           - If wildly mismatched, award 0 points.
        3. Deep Synergy (up to 30 points):
           - Read the startup's description vs the opportunity's description. If there is a good strategic fit, award up to 30 points.

        CRITICAL: Never output markdown. Only output a valid JSON array. Do not output python code.
        Format: [ { "opportunity_id": "...", "score": 85 }, ... ]
        
        Founder Profile:
        - Sector: ${profile.sector || 'Unknown'}
        - Stage: ${profile.stage || 'Unknown'}
        - Desc: ${profile.description || 'Unknown'}

        Opportunities to Evaluate: 
        ${JSON.stringify(chunk.map(o => ({ 
          opportunity_id: o.opportunity_id, 
          title: o.title, 
          sector: o.sector, 
          stage: o.stage, 
          desc: (o.description || '').substring(0, 300) 
        })))}
      `;

      let resultText = await callLLM(prompt);

      // Clean potential markdown or chatter - Use robust regex to find the [ array ] or { object }
      let results = extractJSON(resultText);

      if (!results) {
        chunk.forEach(o => allResults.push({ opportunity_id: o.opportunity_id, score: 0 }));
        continue;
      }

      let items = Array.isArray(results) ? results : (Object.values(results).find(v => Array.isArray(v)) || [results]);
      if (Array.isArray(items)) {
        allResults = allResults.concat(items);
      } else {
        chunk.forEach(o => allResults.push({ opportunity_id: o.opportunity_id, score: 0 }));
      }
    }

    // ID RECOVERY: Ensure every opportunity has a score
    const scoredIds = allResults.filter(p => p && p.opportunity_id).map(p => p.opportunity_id);
    const finalScores = allResults.filter(p => p && p.opportunity_id);

    opportunities.forEach(o => {
      if (!scoredIds.includes(o.opportunity_id)) {
        finalScores.push({ opportunity_id: o.opportunity_id, score: 0 });
      }
    });

    console.log(`✅ AI delivered scores for ${finalScores.length} items.`);
    res.json({ result: finalScores });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/summarize-opportunity
// Summarize in 3 bullets
app.post('/api/ai/summarize-opportunity', async (req, res) => {
  try {
    const { description } = req.body;
    const prompt = `Summarize the following opportunity in exactly 3 short bullet points. Only output the bullets.\n\nDescription: ${description}`;
    const result = await callOpenRouter(prompt);
    res.json({ result: result.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/eligibility
// Check eligibility
app.post('/api/ai/eligibility', async (req, res) => {
  try {
    const { profile, eligibility, description, opportunity_title, opportunity_sector } = req.body;
    
    console.log(`🔍 Eligibility Check: Startup Sector [${profile.sector || ''}] vs Opportunity [${opportunity_title}]`);

    const prompt = `You are a strict, objective Startup Funding Advisor. Your goal is to determine if a startup is eligible for a specific funding opportunity based on the provided details.

STARTUP PROFILE:
Name: ${profile.startup_name || 'Unnamed Startup'}
Sector: ${profile.sector || 'Unspecified'}
Stage: ${profile.stage || 'Unspecified'}
Description: ${profile.description || 'No description provided'}

OPPORTUNITY DETAILS:
Title: ${opportunity_title}
Sector Focus: ${opportunity_sector}
Description: ${description || 'Not provided'}
Known Criteria: ${eligibility !== 'See opportunity page for detailed eligibility criteria.' ? eligibility : 'Use description to infer criteria'}

RULES FOR EVALUATION:
1. Analyze the startup's sector, stage, and description against the opportunity's focus and description.
2. If the opportunity requires a specific sector (e.g., DeepTech) and the startup is in a completely different sector (e.g., EdTech) with no overlap, they are INELIGIBLE.
3. If the opportunity requires a specific stage (e.g., Early Revenue) and the startup is at Idea stage, they are INELIGIBLE.
4. If there's a reasonable overlap or the opportunity is sector-agnostic ("All Sectors"), they are ELIGIBLE.
5. Provide a realistic assessment. Do not force an ELIGIBLE status if there is a clear mismatch.

OUTPUT FORMAT:
STATUS: [ELIGIBLE or INELIGIBLE or POTENTIALLY ELIGIBLE]
- [Brief reason based on sector fit]
- [Brief reason based on stage or technological synergy]
- [Final conclusion]`;
    
    const result = await callOpenRouter(prompt);
    res.json({ result: result.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/generate-draft
// Enhanced auto-fill application based on profile with improved accuracy
app.post('/api/ai/generate-draft', async (req, res) => {
    console.log('[AI] Generate Draft Request Received');
    try {
        const { profile, form_fields, form_schema, opportunity } = req.body;
        console.log('[AI] Opportunity:', opportunity?.title || opportunity?.opportunity_id);
    const normalizedSchema = form_schema ? normalizeSchema(form_schema, opportunity?.title || 'Application Draft') : null;
    const fieldContext = normalizedSchema
      ? flattenSchema(normalizedSchema).map(field => ({
          id: field.id,
          label: field.label,
          type: field.type,
          required: field.required,
          options: field.options,
          help_text: field.help_text,
          max_words: field.max_words
        }))
      : Object.entries(form_fields || {}).map(([id, label]) => ({ id, label, type: 'textarea', required: false }));

    // Enhanced prompt with better context and validation
    const prompt = `
      You are an expert grant application assistant. Fill this application form using the founder's profile and opportunity details.
      
      CRITICAL RULES:
      1. ONLY use information explicitly stated in the profile
      2. NEVER invent metrics, revenue figures, customer counts, or partnerships
      3. For financial numbers, use exact figures from profile or leave empty
      4. Keep responses concise and professional
      5. For unknown/missing information, use empty string ""
      6. Match the exact field requirements (word limits, format)
      
      Profile Analysis:
      - Startup: ${profile.startup_name || 'Not specified'}
      - Sector: ${profile.sector || 'Not specified'}
      - Stage: ${profile.stage || 'Not specified'}
      - Overview: ${profile.startup_overview || 'Not specified'}
      - Problem: ${profile.problem_statement || 'Not specified'}
      - Solution: ${profile.solution_summary || 'Not specified'}
      - Target Market: ${profile.target_customers || 'Not specified'}
      - Business Model: ${profile.business_model || 'Not specified'}
      - Team Size: ${profile.team_size || 'Not specified'}
      - Founded: ${profile.founded_year || 'Not specified'}
      
      Opportunity Context:
      - Title: ${opportunity?.title || 'Not specified'}
      - Provider: ${opportunity?.provider || 'Not specified'}
      - Type: ${opportunity?.type || 'Not specified'}
      - Sector Focus: ${opportunity?.sector || 'Not specified'}
      - Stage Focus: ${opportunity?.stage || 'Not specified'}
      
      Form Fields to Complete:
      ${JSON.stringify(fieldContext, null, 2)}
      
      Return ONLY a valid JSON object with field IDs as keys. No markdown, no explanations. 
      IMPORTANT: If you cannot find information for a field, use an empty string "". 
      DO NOT include any text before or after the JSON.
      
      Example format:
      {
        "field_id_1": "answer based on profile",
        "field_id_2": "another answer",
        "field_id_3": ""
      }
    `;
    
    console.log(`🤖 Generating AI draft for ${opportunity?.title || 'unknown opportunity'}...`);
    const aiResponse = await callLLM(prompt);
    console.log('[AI] Raw Response Received (first 100 chars):', aiResponse?.substring(0, 100));
    
    const parsed = extractJSON(aiResponse);
    console.log('[AI] Extracted JSON keys:', parsed ? Object.keys(parsed) : 'FAILED');
    
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('AI failed to return a valid draft object');
    }

    // Validate and clean the AI response
    const cleanedDraft = {};
    Object.keys(parsed).forEach(fieldId => {
      const field = fieldContext.find(f => f.id === fieldId);
      if (!field) return; // Skip unknown fields
      
      let value = parsed[fieldId];
      
      // Type-specific validation
      if (field.type === 'checkbox') {
        cleanedDraft[fieldId] = Boolean(value);
      } else if (field.type === 'select') {
        cleanedDraft[fieldId] = field.options && field.options.includes(value) ? value : '';
      } else if (typeof value === 'string') {
        // Apply word limits if specified
        if (field.max_words && value.split(' ').length > field.max_words) {
          const words = value.split(' ').slice(0, field.max_words);
          cleanedDraft[fieldId] = words.join(' ');
        } else {
          cleanedDraft[fieldId] = value.trim();
        }
      } else {
        cleanedDraft[fieldId] = String(value).trim();
      }
    });

    // Fill required fields with empty strings if missing
    fieldContext.forEach(field => {
      if (field.required && !(field.id in cleanedDraft)) {
        cleanedDraft[field.id] = '';
      }
    });

    console.log(`✅ AI draft generated with ${Object.keys(cleanedDraft).length} fields completed`);
    res.json({ result: cleanedDraft });
  } catch (err) {
    console.error('❌ AI draft generation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/map-fields
// Use AI to map page labels to draft field IDs when direct text matching fails
app.post('/api/ai/map-fields', async (req, res) => {
    try {
        const { pageFields, draftSchema } = req.body;
        
        const draftFields = flattenSchema(draftSchema).map(f => ({ id: f.id, label: f.label }));
        
        const prompt = `
            You are an expert at mapping form fields between different systems.
            
            DRAFT FIELDS (Your source of truth):
            ${JSON.stringify(draftFields, null, 2)}
            
            PORTAL FIELDS (Found on the live webpage):
            ${JSON.stringify(pageFields.map(f => ({ id: f.id, label: f.label })), null, 2)}
            
            TASK:
            Map the PORTAL FIELDS to the DRAFT FIELDS.
            Many portal labels might be slightly different (e.g. "Company Name" vs "Startup Name").
            
            RETURN ONLY a JSON object where the key is the PORTAL FIELD ID and the value is the matching DRAFT FIELD ID.
            If no match is found for a portal field, omit it.
            
            Example Format:
            {
                "portal_input_1": "startup_name",
                "portal_input_2": "founder_email"
            }
        `;

        console.log('🤖 AI System: Mapping fuzzy fields for extension...');
        const aiResponse = await callLLM(prompt);
        const mapping = extractJSON(aiResponse);
        
        res.json({ mapping: mapping || {} });
    } catch (err) {
        console.error('Field mapping failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/ai/draft-progress
// Enhanced analysis with detailed insights and actionable suggestions
app.post('/api/ai/draft-progress', async (req, res) => {
  try {
    const { draft, form_schema, opportunity } = req.body;
    
    // Calculate basic completion metrics
    const fields = form_schema ? flattenSchema(form_schema) : [];
    const totalFields = fields.length;
    const completedFields = Object.keys(draft.form_fields || {}).length;
    const requiredFields = fields.filter(f => f.required).length;
    const completedRequired = Object.keys(draft.form_fields || {}).filter(fieldId => {
      const field = fields.find(f => f.id === fieldId);
      return field?.required && draft.form_fields[fieldId] && draft.form_fields[fieldId].trim() !== '';
    }).length;
    
    const completionRate = totalFields > 0 ? Math.round((completedFields / totalFields) * 100) : 0;
    const requiredCompletionRate = requiredFields > 0 ? Math.round((completedRequired / requiredFields) * 100) : 0;
    
    const prompt = `
      You are an expert grant application reviewer. Analyze this draft and provide actionable feedback.
      
      Draft Details:
      - Title: ${draft.title || 'Untitled'}
      - Completion: ${completedFields}/${totalFields} fields (${completionRate}%)
      - Required Fields: ${completedRequired}/${requiredFields} completed (${requiredCompletionRate}%)
      - Opportunity: ${opportunity?.title || 'Not specified'}
      - Sector: ${opportunity?.sector || 'Not specified'}
      
      Form Fields Content:
      ${JSON.stringify(draft.form_fields || {}, null, 2)}
      
      Form Schema:
      ${JSON.stringify(fields, null, 2)}
      
      Return a JSON object with:
      {
        "completion_analysis": {
          "total_fields": ${totalFields},
          "completed_fields": ${completedFields},
          "completion_rate": ${completionRate},
          "required_fields": ${requiredFields},
          "completed_required": ${completedRequired},
          "required_completion_rate": ${requiredCompletionRate}
        },
        "missing_required_fields": ["field_id1", "field_id2"],
        "quality_assessment": {
          "strengths": ["strength1", "strength2"],
          "weaknesses": ["weakness1", "weakness2"],
          "overall_score": 75
        },
        "actionable_suggestions": [
          "Specific suggestion 1",
          "Specific suggestion 2",
          "Specific suggestion 3"
        ],
        "priority_improvements": [
          {
            "field": "field_id",
            "issue": "specific issue",
            "suggestion": "how to fix"
          }
        ]
      }
      
      Focus on:
      1. Missing required fields
      2. Quality of responses (too brief, vague, missing key details)
      3. Alignment with opportunity requirements
      4. Professional presentation
      5. Specific, measurable achievements where possible
    `;
    
    console.log(`🔍 Analyzing draft progress for ${draft.title || 'untitled draft'}...`);
    const result = await callOpenRouter(prompt);
    const analysis = extractJSON(result);
    
    if (!analysis) {
      throw new Error('AI failed to return valid draft analysis');
    }
    
    // Combine AI analysis with calculated metrics
    const enhancedAnalysis = {
      ...analysis,
      completion_analysis: {
        total_fields: totalFields,
        completed_fields: completedFields,
        completion_rate: completionRate,
        required_fields: requiredFields,
        completed_required: completedRequired,
        required_completion_rate: requiredCompletionRate
      },
      next_steps: completionRate >= 80 ? ['Review and submit', 'Add supporting documents'] : ['Complete missing fields', 'Improve existing responses'],
      estimated_time_to_complete: Math.ceil((totalFields - completedFields) * 2) + ' minutes'
    };
    
    console.log(`✅ Draft analysis complete: ${completionRate}% complete, ${analysis.actionable_suggestions?.length || 0} suggestions`);
    res.json({ result: enhancedAnalysis });
  } catch (err) {
    console.error('❌ Draft progress analysis failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/feedback-insights
// Output suggestions and improvements for a previous rejection
app.post('/api/ai/feedback-insights', async (req, res) => {
  try {
    const { application } = req.body;
    const prompt = `
      Analyze this rejected application and return suggestions for improving the next application.
      Return exactly 3 actionable bullet points.
      
      Application: ${JSON.stringify(application)}
    `;
    const result = await callOpenRouter(prompt);
    res.json({ result: result.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/profile-completion
// Output missing fields and suggestions
app.post('/api/ai/profile-completion', async (req, res) => {
  try {
    const { profile } = req.body;
    const prompt = `
      Analyze this founder profile. Identify missing critical information and suggest improvements.
      Return a JSON object with "missing_fields" (array) and "suggestions" (array).
      
      Profile: ${JSON.stringify(profile)}
    `;
    const result = await callOpenRouter(prompt);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Nightly automated scraper handled via single cron job at Line 255

// ─── STATIC FILES & 404S ──────────────────────────────────────────────────────
app.use(express.static(__dirname)); // Moved to end so it doesn't shadow API routes

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  FundMe API running at http://localhost:${PORT}`);
  console.log(`    Static files served from: ${__dirname}`);
  console.log(`    Database: ${DB_PATH}`);
});
