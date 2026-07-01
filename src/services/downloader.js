const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const https = require('https');
const http = require('http');

const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'yt-clipper');
const COBALT_URL = process.env.COBALT_URL || ''; // e.g. https://my-cobalt.onrender.com
const COBALT_API_KEY = process.env.COBALT_API_KEY || '';

/**
 * Simple HTTP/HTTPS request that follows redirects.
 */
function request(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const url = new URL(urlStr);

    const req = lib.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        ...options.headers,
      },
      timeout: options.timeout || 30_000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return request(res.headers.location, options).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

/**
 * Download a file from URL to local path.
 */
function downloadFile(fileUrl, destPath, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const lib = fileUrl.startsWith('https') ? https : http;

    const followAndDownload = (url) => {
      const file = require('fs').createWriteStream(destPath);
      lib.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          try { require('fs').unlinkSync(destPath); } catch (_) {}
          return followAndDownload(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          try { require('fs').unlinkSync(destPath); } catch (_) {}
          return reject(new Error(`Download failed: ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(destPath); });
      }).on('error', (e) => {
        file.close();
        try { require('fs').unlinkSync(destPath); } catch (_) {}
        reject(e);
      });
    };

    followAndDownload(fileUrl);
  });
}

/**
 * Download and merge separate video + audio streams using FFmpeg.
 * Needed when only adaptive (DASH) formats are available.
 */
function downloadMerged(videoUrl, audioUrl, outputPath, options = {}) {
  const { startTime, endTime, timeout = 300_000 } = options;
  const duration = (endTime != null && startTime != null) ? (endTime - startTime) : undefined;

  return new Promise((resolve, reject) => {
    const args = [
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    ];
    if (startTime != null) args.push('-ss', String(startTime));
    args.push('-i', videoUrl);
    if (audioUrl) {
      if (startTime != null) args.push('-ss', String(startTime));
      args.push('-i', audioUrl);
    }
    if (duration) args.push('-t', String(duration));
    args.push(
      '-map', '0:v',
      ...(audioUrl ? ['-map', '1:a'] : []),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y', outputPath,
    );

    const proc = execFile('ffmpeg', args, { timeout }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`FFmpeg merge failed: ${(stderr || '').slice(-300) || err.message}`));
        return;
      }
      resolve();
    });
    proc.stderr?.on('data', d => {
      const msg = d.toString();
      if (msg.includes('frame=') || msg.includes('speed=')) {
        if (Math.random() < 0.05) process.stderr.write(d);
      }
    });
  });
}

/**
 * Extract YouTube video ID from any YouTube URL.
 */
function extractVideoId(url) {
  const match = url.match(/(?:v=|\/embed\/|youtu\.be\/|\/shorts\/|\/live\/)([a-zA-Z0-9_-]{11})/);
  if (!match) throw new Error(`Invalid YouTube URL: ${url}`);
  return match[1];
}

// ====== METHOD 1: Self-hosted Cobalt (most reliable) ======

async function downloadWithCobalt(url, jobDir) {
  if (!COBALT_URL) {
    throw new Error('COBALT_URL not configured');
  }

  console.log(`[downloader] Using self-hosted Cobalt: ${COBALT_URL}`);

  const payload = JSON.stringify({
    url,
    videoQuality: '1080',
    filenameStyle: 'basic',
    downloadMode: 'auto',
  });

  const reqHeaders = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  };
  if (COBALT_API_KEY) {
    reqHeaders['Authorization'] = `Bearer ${COBALT_API_KEY}`;
  }

  const resp = await request(COBALT_URL, {
    method: 'POST',
    headers: reqHeaders,
    body: payload,
    timeout: 60_000,
  });

  if (resp.status !== 200) {
    throw new Error(`Cobalt returned status ${resp.status}: ${resp.body.toString().slice(0, 200)}`);
  }

  const data = JSON.parse(resp.body.toString());

  if (data.status === 'error') {
    throw new Error(`Cobalt error: ${data.error?.code || JSON.stringify(data)}`);
  }

  // Direct URL
  if (data.url) {
    console.log(`[downloader] Cobalt: downloading from direct URL...`);
    const outputPath = path.join(jobDir, 'source.mp4');
    await downloadFile(data.url, outputPath, 120_000);
    return outputPath;
  }

  // Picker (multiple formats)
  if (data.picker && data.picker.length > 0) {
    const video = data.picker.find(p => p.type === 'video') || data.picker[0];
    if (video.url) {
      console.log(`[downloader] Cobalt: downloading from picker...`);
      const outputPath = path.join(jobDir, 'source.mp4');
      await downloadFile(video.url, outputPath, 120_000);
      return outputPath;
    }
  }

  throw new Error(`Cobalt unexpected response: ${JSON.stringify(data).slice(0, 200)}`);
}

// ====== METHOD 2: Piped API ======

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.in.projectsegfau.lt',
  'https://pipedapi.r4fo.com',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.darkness.services',
  'https://watchapi.whatever.social',
];

async function downloadWithPiped(videoId, jobDir) {
  try {
    const streamInfo = await getPipedStreamUrl(videoId);
    const outputPath = path.join(jobDir, 'source.mp4');

    if (streamInfo.type === 'progressive') {
      console.log(`[downloader] Piped: downloading progressive...`);
      await downloadFile(streamInfo.url, outputPath);
    } else {
      console.log(`[downloader] Piped: downloading adaptive (video+audio merge)...`);
      await downloadMerged(streamInfo.videoUrl, streamInfo.audioUrl, outputPath);
    }
    return outputPath;
  } catch (e) {
    console.warn(`[downloader] Piped failed: ${e.message}`);
    throw e;
  }
}

// ====== METHOD 2: Invidious API ======

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yt.artemislena.eu',
  'https://invidious.privacyredirect.com',
  'https://vid.puffyan.us',
  'https://invidious.fdn.fr',
  'https://iv.ggtyler.dev',
  'https://invidious.lunar.icu',
  'https://invidious.materialio.us',
];

async function downloadWithInvidious(videoId, jobDir) {
  try {
    const streamInfo = await getInvidiousStreamUrl(videoId);
    const outputPath = path.join(jobDir, 'source.mp4');

    if (streamInfo.type === 'progressive') {
      console.log(`[downloader] Invidious: downloading progressive...`);
      await downloadFile(streamInfo.url, outputPath);
    } else {
      console.log(`[downloader] Invidious: downloading adaptive (video+audio merge)...`);
      await downloadMerged(streamInfo.videoUrl, streamInfo.audioUrl, outputPath);
    }
    return outputPath;
  } catch (e) {
    console.warn(`[downloader] Invidious failed: ${e.message}`);
    throw e;
  }
}

// ====== METHOD 3: yt-dlp (last resort) ======

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
          reject(new Error('Downloaded file not found'));
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

/**
 * Check if a URL is a direct video URL (not a YouTube page).
 */
function isDirectVideoUrl(url) {
  const directHosts = [
    'googlevideo.com',
    'googleusercontent.com',
    'rr5---sn-',
    '.ggpht.com',
  ];
  const directExtensions = ['.mp4', '.webm', '.mkv', '.mov', '.avi'];
  const hasDirectHost = directHosts.some(h => url.includes(h));
  const hasVideoExt = directExtensions.some(e => url.split('?')[0].toLowerCase().endsWith(e));
  return hasDirectHost || hasVideoExt;
}

// ====== STREAM URL GETTERS (for segment download optimization) ======

/**
 * Get stream info from Piped instances.
 * Returns { type: 'progressive', url } or { type: 'adaptive', videoUrl, audioUrl }
 */
async function getPipedStreamUrl(videoId) {
  for (const instance of PIPED_INSTANCES) {
    try {
      const resp = await request(`${instance}/streams/${videoId}`, { timeout: 15_000 });
      if (resp.status !== 200) continue;

      const data = JSON.parse(resp.body.toString());
      if (data.error) continue;

      // Prefer progressive streams (audio + video in one file)
      if (data.videoStreams && data.videoStreams.length > 0) {
        const sorted = data.videoStreams
          .filter(s => s.mimeType?.startsWith('video/mp4') || s.mimeType?.startsWith('video/'))
          .sort((a, b) => (b.quality || 0) - (a.quality || 0));

        for (const s of sorted) {
          if (!s.quality || parseInt(s.quality) <= 1080) {
            console.log(`[downloader] Piped progressive from ${instance} (quality: ${s.quality || 'unknown'})`);
            return { type: 'progressive', url: s.url };
          }
        }
        if (sorted.length > 0) {
          console.log(`[downloader] Piped progressive from ${instance} (fallback quality)`);
          return { type: 'progressive', url: sorted[sorted.length - 1].url };
        }
      }

      // Adaptive formats (separate video + audio) — merge with FFmpeg
      if (data.adaptiveFormats && data.adaptiveFormats.length > 0) {
        const videoFormats = data.adaptiveFormats
          .filter(f => f.mimeType?.startsWith('video/mp4'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const audioFormats = data.adaptiveFormats
          .filter(f => f.mimeType?.startsWith('audio/'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        if (videoFormats.length > 0 && audioFormats.length > 0) {
          const video = videoFormats.find(f => {
            const q = f.qualityLabel || '';
            return q.includes('720') || q.includes('1080');
          }) || videoFormats[0];
          const audio = audioFormats[0];

          console.log(`[downloader] Piped adaptive from ${instance} (video: ${video.qualityLabel || '?'}, audio: ${audio.bitrate || '?'}bps)`);
          return { type: 'adaptive', videoUrl: video.url, audioUrl: audio.url };
        }
      }
    } catch (e) {
      console.warn(`[downloader] Piped ${instance} stream URL failed: ${e.message}`);
    }
  }
  throw new Error('No stream found on Piped');
}

/**
 * Get stream info from Invidious instances.
 * Returns { type: 'progressive', url } or { type: 'adaptive', videoUrl, audioUrl }
 */
async function getInvidiousStreamUrl(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const resp = await request(
        `${instance}/api/v1/videos/${videoId}?format=json&fields=formatStreams,adaptiveFormats`,
        { timeout: 15_000 }
      );
      if (resp.status !== 200) continue;

      const data = JSON.parse(resp.body.toString());

      // Progressive streams (combined audio+video)
      if (data.formatStreams && data.formatStreams.length > 0) {
        const sorted = [...data.formatStreams].sort((a, b) => {
          const qa = parseInt(a.qualityLabel || a.quality || '0');
          const qb = parseInt(b.qualityLabel || b.quality || '0');
          return qb - qa;
        });
        const stream = sorted.find(s => {
          const q = parseInt(s.qualityLabel || s.quality || '9999');
          return q <= 1080;
        }) || sorted[sorted.length - 1];

        if (stream?.url) {
          console.log(`[downloader] Invidious progressive from ${instance}`);
          return { type: 'progressive', url: stream.url };
        }
      }

      // Adaptive formats (separate video + audio)
      if (data.adaptiveFormats && data.adaptiveFormats.length > 0) {
        const videoFormats = data.adaptiveFormats
          .filter(f => f.type?.startsWith('video/mp4'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const audioFormats = data.adaptiveFormats
          .filter(f => f.type?.startsWith('audio/'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        if (videoFormats.length > 0 && audioFormats.length > 0) {
          const video = videoFormats[0];
          const audio = audioFormats[0];
          console.log(`[downloader] Invidious adaptive from ${instance}`);
          return { type: 'adaptive', videoUrl: video.url, audioUrl: audio.url };
        }
      }
    } catch (e) {
      console.warn(`[downloader] Invidious ${instance} stream URL failed: ${e.message}`);
    }
  }
  throw new Error('No stream found on Invidious');
}

/**
 * Get a stream URL from the provider chain (no download).
 * Prefers Piped (proxy URLs) > Invidious.
 */
async function getStreamUrl(url) {
  const videoId = extractVideoId(url);

  try {
    return await getPipedStreamUrl(videoId);
  } catch (e) {
    console.warn(`[downloader] getStreamUrl: Piped failed: ${e.message}`);
  }

  try {
    return await getInvidiousStreamUrl(videoId);
  } catch (e) {
    console.warn(`[downloader] getStreamUrl: Invidious failed: ${e.message}`);
  }

  throw new Error('All stream URL providers failed');
}

/**
 * Download only a segment of a video using FFmpeg input seeking.
 * Instead of downloading the full video (~580MB), FFmpeg only fetches
 * the bytes needed for the requested time range (e.g., 30s = ~29MB).
 */
async function downloadVideoSegment(url, jobId, startTime, endTime) {
  const jobDir = path.join(TMP_DIR, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  const streamInfo = await getStreamUrl(url);
  const outputPath = path.join(jobDir, 'segment.mp4');
  const duration = endTime - startTime;

  if (duration <= 0) throw new Error('endTime must be greater than startTime');
  if (duration > 600) throw new Error('Segment duration cannot exceed 10 minutes');

  console.log(`[downloader] Segment download: ${startTime}s - ${endTime}s (${duration.toFixed(1)}s) [${streamInfo.type}]`);

  if (streamInfo.type === 'progressive') {
    // Single URL: FFmpeg seek + stream copy
    await new Promise((resolve, reject) => {
      const args = [
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        '-ss', startTime.toString(),
        '-i', streamInfo.url,
        '-t', duration.toString(),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        '-y', outputPath,
      ];
      const proc = execFile('ffmpeg', args, { timeout: 180_000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`FFmpeg segment failed: ${(stderr || '').slice(-300) || err.message}`));
        else resolve();
      });
      proc.stderr?.on('data', d => {
        const msg = d.toString();
        if (msg.includes('frame=') || msg.includes('speed=')) {
          if (Math.random() < 0.05) process.stderr.write(d);
        }
      });
    });
  } else {
    // Adaptive: download video + audio separately and merge
    await downloadMerged(streamInfo.videoUrl, streamInfo.audioUrl, outputPath, { startTime, endTime, timeout: 180_000 });
  }

  // Verify the downloaded segment
  const stats = await fs.stat(outputPath);
  if (stats.size < 10000) {
    throw new Error(`Segment file too small: ${(stats.size / 1024).toFixed(0)}KB`);
  }

  console.log(`[downloader] Segment downloaded: ${(stats.size / (1024 * 1024)).toFixed(1)}MB [${streamInfo.type}]`);
  return outputPath;
}

// ====== MAIN: Route to appropriate download method ======

async function downloadVideo(url, jobId) {
  const jobDir = path.join(TMP_DIR, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  // Direct video URL (googlevideo, etc.) — download straight, no auth needed
  if (isDirectVideoUrl(url)) {
    console.log(`[downloader] Direct video URL detected, downloading...`);
    const outputPath = path.join(jobDir, 'source.mp4');
    await downloadFile(url, outputPath, 180_000);
    return outputPath;
  }

  // YouTube URL — use the multi-method pipeline
  const videoId = extractVideoId(url);
  console.log(`[downloader] YouTube Video ID: ${videoId}`);

  // Method 1: Self-hosted Cobalt (if configured)
  if (COBALT_URL) {
    try {
      return await downloadWithCobalt(url, jobDir);
    } catch (e) {
      console.warn(`[downloader] Cobalt failed: ${e.message}`);
    }
  }

  // Method 2: Piped API (fallback)
  try {
    return await downloadWithPiped(videoId, jobDir);
  } catch (e) {
    console.warn(`[downloader] Piped failed: ${e.message}`);
  }

  // Method 3: Invidious API (fallback)
  try {
    return await downloadWithInvidious(videoId, jobDir);
  } catch (e) {
    console.warn(`[downloader] Invidious failed: ${e.message}`);
  }

  // Method 4: yt-dlp (last resort)
  try {
    return await downloadWithYtDlp(url, jobDir);
  } catch (e) {
    console.error(`[downloader] yt-dlp failed: ${e.message}`);
  }

  throw new Error(
    'All download methods failed. ' +
    'YouTube may be temporarily blocking server requests. ' +
    'Try again in a few minutes or with a different video.'
  );
}

/**
 * Get video info without downloading.
 */
async function getVideoInfo(url) {
  const videoId = extractVideoId(url);

  // Try Piped first
  for (const instance of PIPED_INSTANCES.slice(0, 2)) {
    try {
      const resp = await request(`${instance}/streams/${videoId}`, { timeout: 10_000 });
      if (resp.status === 200) {
        const data = JSON.parse(resp.body.toString());
        return {
          title: data.title || 'Unknown',
          duration: data.duration || 0,
          width: 1920,
          height: 1080,
          thumbnail: data.thumbnailUrl || null,
        };
      }
    } catch (e) { /* skip */ }
  }

  // Fallback
  return {
    title: 'Video info unavailable',
    duration: 0,
    width: 1920,
    height: 1080,
    thumbnail: null,
  };
}

module.exports = { downloadVideo, getVideoInfo, getStreamUrl, downloadVideoSegment };