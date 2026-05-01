require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// DB Helpers
function readDB() {
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// Basic API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/opportunities', (req, res) => {
  try {
    const db = readDB();
    res.json(db.opportunities || []);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load opportunities' });
  }
});

app.get('/api/users/check-email', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email query parameter is required' });

  const db = readDB();
  const existing = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  res.json({ exists: !!existing });
});

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
      password: hashedPassword,
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

// Serve static files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 FundMe server running successfully!`);
  console.log(`📱 Local URL: http://localhost:${PORT}`);
  console.log(`🌐 Network URL: http://0.0.0.0:${PORT}`);
  console.log(`📊 Health Check: http://localhost:${PORT}/api/health`);
  console.log(`\n🎯 Test Links:`);
  console.log(`   • Main Site: http://localhost:${PORT}/index.html`);
  console.log(`   • Enhanced Drafts: http://localhost:${PORT}/drafts-enhanced.html`);
  console.log(`   • Draft Generator: http://localhost:${PORT}/draft-generator-enhanced.html`);
  console.log(`   • Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`   • Explorer: http://localhost:${PORT}/explorer.html`);
  console.log(`\n✨ Server is ready for testing!`);
});

module.exports = app;
