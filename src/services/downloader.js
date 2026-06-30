const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const https = require('https');
const http = require('http');

const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'yt-clipper');

/**
 * Make an HTTP/HTTPS request and return the full response body.
 */
function fetchUrl(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const req = lib.request(urlStr, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 60_000,
    }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, options).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Download a file from a URL to a local path.
 */
function downloadFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const lib = fileUrl.startsWith('https') ? https : http;
    const file = require('fs').createWriteStream(destPath);
    lib.get(fileUrl, { timeout: 120_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        require('fs').unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        require('fs').unlinkSync(destPath).catch(() => {});
        return reject(new Error(`Download failed with status ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    }).on('error', (e) => {
      file.close();
      require('fs').unlinkSync(destPath).catch(() => {});
      reject(e);
    });
  });
}

// ====== METHOD 1: Cobalt API (primary, no auth needed) ======

const COBALT_ENDPOINTS = [
  'https://api.cobalt.tools',
  'https://cobalt-api.kwiatekmiki.com',
];

async function downloadWithCobalt(url, jobDir) {
  const payload = JSON.stringify({
    url,
    videoQuality: '1080',
    filenameStyle: 'pretty',
    downloadMode: 'auto',
  });

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  };

  let lastError;

  for (const endpoint of COBALT_ENDPOINTS) {
    try {
      console.log(`[downloader] Trying cobalt: ${endpoint}`);
      const resp = await fetchUrl(endpoint, {
        method: 'POST',
        headers,
        body: payload,
        timeout: 30_000,
      });

      const data = JSON.parse(resp.body.toString());

      if (data.status === 'error') {
        console.warn(`[downloader] Cobalt error: ${data.error?.code || JSON.stringify(data)}`);
        lastError = new Error(`Cobalt error: ${data.error?.code || 'unknown'}`);
        continue;
      }

      // Cobalt returns different response formats
      if (data.url) {
        // Direct download URL
        console.log(`[downloader] Cobalt gave direct URL, downloading...`);
        const outputPath = path.join(jobDir, 'source.mp4');
        await downloadFile(data.url, outputPath);
        return outputPath;
      }

      if (data.picker && data.picker.length > 0) {
        // Multiple formats — pick the best video
        const video = data.picker.find(p => p.type === 'video') || data.picker[0];
        if (video.url) {
          console.log(`[downloader] Cobalt picker: downloading ${video.type}`);
          const outputPath = path.join(jobDir, 'source.mp4');
          await downloadFile(video.url, outputPath);
          return outputPath;
        }
      }

      lastError = new Error(`Cobalt unexpected response: ${JSON.stringify(data).slice(0, 200)}`);
    } catch (e) {
      console.warn(`[downloader] Cobalt ${endpoint} failed: ${e.message}`);
      lastError = e;
    }
  }

  throw lastError || new Error('All cobalt endpoints failed');
}

// ====== METHOD 2: yt-dlp (fallback) ======

async function downloadWithYtDlp(url, jobDir) {
  const outputPath = path.join(jobDir, 'source.%(ext)s');

  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-cache-dir',
      '--extractor-args', 'youtube:player_client=web',
      '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]/best',
      '--merge-output-format', 'mp4',
      '-o', outputPath,
      '--concurrent-fragments', '4',
      url,
    ];

    console.log(`[downloader] Trying yt-dlp...`);
    const proc = execFile('yt-dlp', args, {
      timeout: 300_000,
      maxBuffer: 5 * 1024 * 1024,
    }, async (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`yt-dlp failed: ${(stderr || '').slice(-300) || err.message}`));
        return;
      }
      try {
        const files = await fs.readdir(jobDir);
        const videoFile = files.find(f => f.startsWith('source.') && !f.endsWith('.part'));
        if (!videoFile) {
          reject(new Error('Downloaded file not found after yt-dlp completed'));
          return;
        }
        resolve(path.join(jobDir, videoFile));
      } catch (e) {
        reject(e);
      }
    });

    proc.stdout?.on('data', d => process.stdout.write(d));
    proc.stderr?.on('data', d => process.stderr.write(d));
  });
}

// ====== MAIN: Try cobalt first, then yt-dlp ======

async function downloadVideo(url, jobId) {
  const jobDir = path.join(TMP_DIR, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  // Method 1: Cobalt (no auth, most reliable for YouTube)
  try {
    return await downloadWithCobalt(url, jobDir);
  } catch (cobaltErr) {
    console.warn(`[downloader] Cobalt failed: ${cobaltErr.message}`);
  }

  // Method 2: yt-dlp fallback
  try {
    return await downloadWithYtDlp(url, jobDir);
  } catch (ytdlpErr) {
    console.error(`[downloader] yt-dlp also failed: ${ytdlpErr.message}`);
  }

  throw new Error(
    'All download methods failed. YouTube is blocking the request. ' +
    'Try again later or use a different video.'
  );
}

/**
 * Get video metadata (duration, resolution, etc.) without downloading.
 */
async function getVideoInfo(url) {
  // Try yt-dlp first for metadata
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=web',
      url,
    ];

    execFile('yt-dlp', args, {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        // Fallback: try cobalt for basic info
        console.warn(`[downloader] yt-dlp info failed, returning basic info`);
        resolve({
          title: 'Video info unavailable',
          duration: 0,
          width: 1920,
          height: 1080,
          thumbnail: null,
          note: 'YouTube metadata extraction was blocked',
        });
        return;
      }
      try {
        const info = JSON.parse(stdout);
        resolve({
          title: info.title,
          duration: info.duration,
          width: info.width,
          height: info.height,
          thumbnail: info.thumbnail,
        });
      } catch (e) {
        reject(new Error(`Failed to parse yt-dlp output: ${e.message}`));
      }
    });
  });
}

module.exports = { downloadVideo, getVideoInfo };