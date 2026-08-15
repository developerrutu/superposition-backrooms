/**
 * Superposition Backrooms — Railway hosting server.
 *
 * Serves the static game from /public, with proper caching headers,
 * range support, and SPA fallback to index.html so deep links work.
 *
 * Bind to 0.0.0.0 by default so Railway's external proxy can reach it.
 */

const express = require('express');
const compression = require('compression');
const path = require('path');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(compression());

// Cache static assets aggressively, but never index.html (so updates ship).
const STATIC_DIR = path.join(__dirname, 'public');

app.use((req, res, next) => {
  if (req.path !== '/' && req.path !== '/index.html') {
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  }
  next();
});

app.use(express.static(STATIC_DIR, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// SPA fallback — anything not matched above returns the game shell.
app.get('*', (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[superposition-backrooms] listening on http://${HOST}:${PORT}`);
});

// Graceful shutdown so Railway can restart us cleanly.
process.on('SIGTERM', () => {
  console.log('[superposition-backrooms] SIGTERM received, draining...');
  server.close(() => process.exit(0));
});
