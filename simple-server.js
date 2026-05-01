const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Basic API route for testing
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve all HTML files
app.get('*', (req, res) => {
  const filePath = path.join(__dirname, req.path);
  if (fs.existsSync(filePath) && filePath.endsWith('.html')) {
    res.sendFile(filePath);
  } else if (req.path === '/') {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.status(404).send('Page not found');
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 FundMe server is running!');
  console.log('');
  console.log('📱 LOCAL TESTING LINKS:');
  console.log('   • Main Site: http://localhost:3000');
  console.log('   • Enhanced Drafts: http://localhost:3000/drafts-enhanced.html');
  console.log('   • Draft Generator: http://localhost:3000/draft-generator-enhanced.html');
  console.log('   • Dashboard: http://localhost:3000/dashboard.html');
  console.log('   • Explorer: http://localhost:3000/explorer.html');
  console.log('   • Applications: http://localhost:3000/applications.html');
  console.log('');
  console.log('🌐 Network Access: http://0.0.0.0:3000');
  console.log('📊 Health Check: http://localhost:3000/api/health');
  console.log('');
  console.log('✨ Server is ready for testing! Open any link above in your browser.');
});
