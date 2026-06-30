const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'yt-clipper');

/**
 * Download a YouTube video using yt-dlp.
 * Returns the path to the downloaded file.
 */
async function downloadVideo(url, jobId) {
  const jobDir = path.join(TMP_DIR, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  const outputPath = path.join(jobDir, 'source.%(ext)s');

  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-cache-dir',
      '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', outputPath,
      '--concurrent-fragments', '4',
      url,
    ];

    const proc = execFile('yt-dlp', args, {
      timeout: 300_000, // 5 min max download
      maxBuffer: 5 * 1024 * 1024,
    }, async (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`yt-dlp failed: ${stderr || err.message}`));
        return;
      }
      try {
        // Find the actual downloaded file (yt-dlp replaces %(ext)s)
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

    // Allow parent to kill the process if needed
    proc.stdout?.on('data', d => process.stdout.write(d));
    proc.stderr?.on('data', d => process.stderr.write(d));
  });
}

/**
 * Get video metadata (duration, resolution, etc.) without downloading.
 */
async function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      url,
    ];

    execFile('yt-dlp', args, {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`yt-dlp info failed: ${stderr || err.message}`));
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