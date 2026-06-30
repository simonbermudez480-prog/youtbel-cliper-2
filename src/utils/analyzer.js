const sharp = require('sharp');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'yt-clipper');

/**
 * Extract N frames from a video at evenly spaced timestamps.
 * Returns an array of paths to the extracted frame images.
 */
async function extractFrames(videoPath, jobDir, numFrames = 10) {
  const framesDir = path.join(jobDir, 'frames');
  await fs.mkdir(framesDir, { recursive: true });

  // Get video duration
  const duration = await getVideoDuration(videoPath);
  const interval = duration / (numFrames + 1);

  const framePaths = [];
  const extractPromises = [];

  for (let i = 1; i <= numFrames; i++) {
    const timestamp = interval * i;
    const framePath = path.join(framesDir, `frame_${i.toString().padStart(3, '0')}.jpg`);
    framePaths.push(framePath);

    extractPromises.push(
      new Promise((resolve, reject) => {
        const args = [
          '-ss', timestamp.toString(),
          '-i', videoPath,
          '-frames:v', '1',
          '-q:v', '5',
          '-y',
          framePath,
        ];
        execFile('ffmpeg', args, { timeout: 15_000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      })
    );
  }

  await Promise.all(extractPromises);
  return framePaths;
}

/**
 * Get video duration in seconds.
 */
function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ];
    execFile('ffprobe', args, { timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(parseFloat(stdout.trim()));
    });
  });
}

/**
 * Get video dimensions { width, height }.
 */
function getVideoDimensions(videoPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      videoPath,
    ];
    execFile('ffprobe', args, { timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else {
        const data = JSON.parse(stdout);
        const stream = data.streams[0];
        resolve({ width: stream.width, height: stream.height });
      }
    });
  });
}

/**
 * Analyze a single frame to find the horizontal center of the region of interest.
 * 
 * Algorithm:
 * 1. Resize frame to a small width for speed (keep aspect ratio)
 * 2. Convert to grayscale raw pixels
 * 3. Divide the frame into vertical strips (columns)
 * 4. For each strip, calculate the "visual energy" — variance of luminance
 *    High energy = lots of detail/edges = likely the subject
 * 5. Find the weighted center of the high-energy strips
 */
async function analyzeFrame(framePath) {
  const analysisWidth = 320; // Small enough for fast processing
  const numStrips = 16;       // Number of vertical strips to analyze

  const image = sharp(framePath);
  const metadata = await image.metadata();

  const raw = await image
    .resize(analysisWidth, null, { withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer();

  const pixels = analysisWidth * metadata.height;
  const stripWidth = Math.floor(analysisWidth / numStrips);
  const stripEnergies = [];

  for (let s = 0; s < numStrips; s++) {
    const startX = s * stripWidth;
    const luminances = [];

    for (let y = 0; y < metadata.height; y++) {
      for (let x = startX; x < startX + stripWidth && x < analysisWidth; x++) {
        const idx = (y * analysisWidth + x) * 3;
        // Luminance from RGB
        const luma = 0.299 * raw[idx] + 0.587 * raw[idx + 1] + 0.114 * raw[idx + 2];
        luminances.push(luma);
      }
    }

    // Calculate variance (visual energy) of this strip
    const mean = luminances.reduce((a, b) => a + b, 0) / luminances.length;
    const variance = luminances.reduce((sum, l) => sum + (l - mean) ** 2, 0) / luminances.length;
    stripEnergies.push({ index: s, energy: variance });
  }

  // Find the weighted center of high-energy strips
  // Use a threshold: only consider strips with energy above 40th percentile
  const energies = stripEnergies.map(s => s.energy).sort((a, b) => a - b);
  const thresholdIdx = Math.floor(energies.length * 0.4);
  const threshold = energies[thresholdIdx];

  const highEnergyStrips = stripEnergies.filter(s => s.energy > threshold);
  if (highEnergyStrips.length === 0) {
    return analysisWidth / 2; // Fallback to center
  }

  const totalEnergy = highEnergyStrips.reduce((sum, s) => sum + s.energy, 0);
  const weightedCenter = highEnergyStrips.reduce((sum, s) => {
    const stripCenter = (s.index + 0.5) * stripWidth;
    return sum + stripCenter * (s.energy / totalEnergy);
  }, 0);

  // Scale back to original image coordinates
  return (weightedCenter / analysisWidth) * metadata.width;
}

/**
 * Analyze multiple frames and return the optimal crop center X position.
 * Uses temporal smoothing to avoid jittery cropping.
 */
async function analyzeVideo(videoPath, jobDir, options = {}) {
  const { numFrames = 10 } = options;

  console.log(`[analyzer] Extracting ${numFrames} frames for analysis...`);
  const framePaths = await extractFrames(videoPath, jobDir, numFrames);

  console.log('[analyzer] Analyzing frames for region of interest...');
  const centers = [];
  for (const framePath of framePaths) {
    try {
      const center = await analyzeFrame(framePath);
      centers.push(center);
    } catch (e) {
      console.warn(`[analyzer] Frame analysis failed: ${e.message}`);
    }
  }

  if (centers.length === 0) {
    console.warn('[analyzer] All frame analyses failed, falling back to center crop');
    const dims = await getVideoDimensions(videoPath);
    return { cropCenterX: dims.width / 2, confidence: 0 };
  }

  // Calculate weighted moving average (more recent frames have slightly more weight)
  // Actually for evenly sampled frames, simple average is fine
  // But let's use a trimmed mean to ignore outliers
  centers.sort((a, b) => a - b);
  const trimCount = Math.floor(centers.length * 0.15);
  const trimmed = centers.slice(trimCount, centers.length - trimCount);
  const avgCenter = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;

  // Confidence: how clustered are the centers? (lower std dev = higher confidence)
  const stdDev = Math.sqrt(
    trimmed.reduce((sum, c) => sum + (c - avgCenter) ** 2, 0) / trimmed.length
  );
  const dims = await getVideoDimensions(videoPath);
  const confidence = Math.max(0, 1 - stdDev / (dims.width * 0.3));

  console.log(`[analyzer] Optimal crop center: ${avgCenter.toFixed(1)}px (confidence: ${(confidence * 100).toFixed(0)}%)`);

  // Cleanup frames directory
  try {
    await fs.rm(path.join(jobDir, 'frames'), { recursive: true, force: true });
  } catch (e) {
    // Non-critical
  }

  return { cropCenterX: avgCenter, confidence };
}

/**
 * Calculate the optimal crop X position for 9:16 vertical output.
 * Takes into account the video dimensions and the detected center of interest.
 * Ensures the crop stays within video bounds.
 */
function calculateCropParams(videoWidth, videoHeight, cropCenterX, targetWidth, targetHeight) {
  // Calculate the crop width needed (maintain 9:16 ratio based on video height)
  const cropWidth = Math.round(videoHeight * (9 / 16));
  const cropHeight = videoHeight;

  // Clamp crop center so crop doesn't go out of bounds
  const minX = cropWidth / 2;
  const maxX = videoWidth - cropWidth / 2;
  const clampedX = Math.max(minX, Math.min(maxX, cropCenterX));

  // The crop x offset (top-left corner of the crop rectangle)
  const cropX = Math.round(clampedX - cropWidth / 2);

  return {
    cropWidth,
    cropHeight,
    cropX: Math.max(0, Math.min(cropX, videoWidth - cropWidth)),
    cropY: 0,
    scaleWidth: targetWidth || 1080,
    scaleHeight: targetHeight || 1920,
  };
}

module.exports = {
  analyzeVideo,
  analyzeFrame,
  extractFrames,
  getVideoDuration,
  getVideoDimensions,
  calculateCropParams,
};