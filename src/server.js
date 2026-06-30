const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

const { downloadVideo, getVideoInfo } = require('./services/downloader');
const { processVideo, processVideoDynamicPan } = require('./services/processor');

const app = express();
const PORT = process.env.PORT || 3000;
const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'yt-clipper');
const API_KEY = process.env.API_KEY || ''; // Optional API key for auth

// Ensure temp directory exists
fs.mkdir(TMP_DIR, { recursive: true }).catch(() => {});

// --- Middleware ---
app.use(cors());
app.use(morgan('combined'));

// Optional API key auth
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
    res.json({
      success: true,
      data: info,
    });
  } catch (err) {
    console.error('[/api/info]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Main endpoint: Process video ---
app.post('/api/process', async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  console.log(`\n[Job ${jobId}] Started`);

  try {
    const {
      url,
      startTime,
      endTime,
      mode = 'smart',       // 'smart' | 'center' | 'dynamic'
      crf = 23,
      preset = 'fast',
    } = req.body;

    // Validation
    if (!url || !startTime || !endTime) {
      return res.status(400).json({
        error: 'Missing required fields: url, startTime, endTime',
        example: { url: 'https://youtube.com/watch?v=xxx', startTime: '00:01:30', endTime: '00:02:15' },
      });
    }

    const validModes = ['smart', 'center', 'dynamic'];
    if (!validModes.includes(mode)) {
      return res.status(400).json({ error: `Invalid mode. Must be one of: ${validModes.join(', ')}` });
    }

    const jobDir = path.join(TMP_DIR, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    // Step 1: Download
    console.log(`[Job ${jobId}] Downloading video...`);
    const videoPath = await downloadVideo(url, jobId);
    console.log(`[Job ${jobId}] Downloaded: ${videoPath}`);

    // Step 2: Process (cut + smart crop + encode)
    console.log(`[Job ${jobId}] Processing (mode: ${mode})...`);
    let outputPath;

    if (mode === 'dynamic') {
      outputPath = await processVideoDynamicPan(videoPath, startTime, endTime, jobId, {
        crf,
        preset,
      });
    } else {
      outputPath = await processVideo(videoPath, startTime, endTime, jobId, {
        crf,
        preset,
        skipAnalysis: mode === 'center',
        forceCenter: mode === 'center',
      });
    }

    // Step 3: Send the processed video file
    const stats = await fs.stat(outputPath);
    const filename = `vertical_clip_${jobId}.mp4`;

    console.log(`[Job ${jobId}] Done. Size: ${(stats.size / (1024 * 1024)).toFixed(1)}MB`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('X-Job-Id', jobId);

    const stream = require('fs').createReadStream(outputPath);
    stream.pipe(res);

    // Cleanup after response is sent
    stream.on('end', async () => {
      console.log(`[Job ${jobId}] Response sent, cleaning up...`);
      try {
        await fs.rm(jobDir, { recursive: true, force: true });
        console.log(`[Job ${jobId}] Cleaned up`);
      } catch (e) {
        console.warn(`[Job ${jobId}] Cleanup failed: ${e.message}`);
      }
    });

  } catch (err) {
    console.error(`[Job ${jobId}] Error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message, jobId });
    }

    // Cleanup on error
    const jobDir = path.join(TMP_DIR, jobId);
    try {
      await fs.rm(jobDir, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
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