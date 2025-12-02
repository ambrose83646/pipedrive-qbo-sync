require('dotenv').config();
const express = require('express');
const path = require('path');
const routes = require('./src/routes/index');
const { startPolling } = require('./src/jobs/paymentPoller');
const { initializeDatabase } = require('./config/postgres');

const app = express();
const PORT = process.env.PORT || 3000;

// Disable caching for API endpoints
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', routes);

async function startServer() {
  try {
    await initializeDatabase();
    
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      
      startPolling();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
