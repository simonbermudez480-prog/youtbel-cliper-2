const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');

const { downloadVideo, downloadVideoSegment, getVideoInfo } = require('./services/downloader');
const { processVideo, processVideoDynamicPan, parseTime } = require('./services/processor');

const app = express();
const PORT = process.env.PORT || 3000;
const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'yt-clipper');
const API_KEY = process.env.API_KEY || '';

fs.mkdir(TMP_DIR, { recursive: true }).catch(() => {});

// --- Middleware ---
app.use(cors());
app.use(morgan('combined'));

if (API_KEY) {
  app.use('/api', (req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (key !== API_KEY) {
      return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    next();
  });
}

app.use(express.json({ limit: '1mb' }));

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Get video info (no download) ---
app.post('/api/info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'Missing required field: url' });
    }
    const info = await getVideoInfo(url);
    res.json({ success: true, data: info });
  } catch (err) {
    console.error('[/api/info]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Helper: process a local video file and send response ---
async function handleProcess(jobId, videoPath, startTime, endTime, mode, crf, preset, res, options = {}) {
  console.log(`[Job ${jobId}] Processing (mode: ${mode})...`);

  let outputPath;
  if (mode === 'dynamic') {
    outputPath = await processVideoDynamicPan(videoPath, startTime, endTime, jobId, { crf, preset });
  } else {
    outputPath = await processVideo(videoPath, startTime, endTime, jobId, {
      crf,
      preset,
      skipAnalysis: mode === 'center',
      forceCenter: mode === 'center',
      alreadyTrimmed: options.alreadyTrimmed || false,
    });
  }

  const stats = await fs.stat(outputPath);
  const filename = `vertical_clip_${jobId}.mp4`;
  console.log(`[Job ${jobId}] Done. Size: ${(stats.size / (1024 * 1024)).toFixed(1)}MB`);

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Content-Length', stats.size);
  res.setHeader('X-Job-Id', jobId);

  const stream = fsSync.createReadStream(outputPath);
  stream.pipe(res);

  stream.on('end', async () => {
    console.log(`[Job ${jobId}] Response sent, cleaning up...`);
    const jobDir = path.join(TMP_DIR, jobId);
    try { await fs.rm(jobDir, { recursive: true, force: true }); } catch (_) {}
  });
}

// --- Endpoint 1: Process from URL (YouTube or direct) ---
app.post('/api/process', async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  console.log(`\n[Job ${jobId}] Started (URL mode)`);

  try {
    const {
      url,
      startTime,
      endTime,
      mode = 'smart',
      crf = 23,
      preset = 'fast',
    } = req.body;

    // Parse cookies from header (n8n can send them per-request)
    let cookies = [];
    const cookiesHeader = req.headers['x-youtube-cookies'];
    if (cookiesHeader) {
      try { cookies = JSON.parse(cookiesHeader); } catch (_) {}
    }

    if (!url || !startTime || !endTime) {
      return res.status(400).json({
        error: 'Missing required fields: url, startTime, endTime',
      });
    }

    const validModes = ['smart', 'center', 'dynamic'];
    if (!validModes.includes(mode)) {
      return res.status(400).json({ error: `Invalid mode. Must be one of: ${validModes.join(', ')}` });
    }

    // Parse times for segment download attempt
    const startSec = parseTime(startTime);
    const endSec = parseTime(endTime);

    let videoPath;
    let alreadyTrimmed = false;

    // OPTIMIZATION: Try to download only the needed segment (30s = ~29MB vs 580MB full)
    try {
      console.log(`[Job ${jobId}] Trying segment download (${startSec}s - ${endSec}s)...`);
      videoPath = await downloadVideoSegment(url, jobId, startSec, endSec, cookies);
      alreadyTrimmed = true;
      console.log(`[Job ${jobId}] Segment download successful!`);
    } catch (e) {
      console.warn(`[Job ${jobId}] Segment download failed: ${e.message}`);
      console.log(`[Job ${jobId}] Falling back to full video download...`);
      videoPath = await downloadVideo(url, jobId, cookies);
    }
    console.log(`[Job ${jobId}] Source ready: ${videoPath}${alreadyTrimmed ? ' (pre-trimmed)' : ''}`);

    await handleProcess(jobId, videoPath, startTime, endTime, mode, crf, preset, res, { alreadyTrimmed });

  } catch (err) {
    console.error(`[Job ${jobId}] Error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message, jobId });
    }
    const jobDir = path.join(TMP_DIR, jobId);
    try { await fs.rm(jobDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// --- Endpoint 2: Process from uploaded file (streaming to disk, no memory limit) ---
app.post('/api/process-upload', async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  console.log(`\n[Job ${jobId}] Started (Upload streaming mode)`);

  try {
    const startTime = req.headers['x-start-time'] || req.query.startTime;
    const endTime = req.headers['x-end-time'] || req.query.endTime;
    const mode = req.headers['x-mode'] || req.query.mode || 'smart';
    const crf = parseInt(req.headers['x-crf'] || req.query.crf || '23');
    const preset = req.headers['x-preset'] || req.query.preset || 'fast';

    if (!startTime || !endTime) {
      return res.status(400).json({
        error: 'Missing startTime and endTime. Send them as headers (X-Start-Time, X-End-Time) or query params.',
      });
    }

    const jobDir = path.join(TMP_DIR, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    // Stream request body directly to disk (uses almost no RAM)
    const videoPath = path.join(jobDir, 'source.mp4');
    const writeStream = fsSync.createWriteStream(videoPath);

    await new Promise((resolve, reject) => {
      req.pipe(writeStream);
      writeStream.on('finish', () => {
        console.log(`[Job ${jobId}] File saved: ${videoPath}`);
        resolve();
      });
      writeStream.on('error', reject);
      req.on('error', reject);
    });

    await handleProcess(jobId, videoPath, startTime, endTime, mode, crf, preset, res);

  } catch (err) {
    console.error(`[Job ${jobId}] Error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message, jobId });
    }
    const jobDir = path.join(TMP_DIR, jobId);
    try { await fs.rm(jobDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// --- Error handler ---
app.use((err, req, res, _next) => {
  console.error('[Unhandled error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`\n🎬 YouTube Vertical Clipper API`);
  console.log(`   Listening on port ${PORT}`);
  console.log(`   Temp dir: ${TMP_DIR}`);
  console.log(`   Modes: smart | center | dynamic\n`);
});