const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { analyzeVideo, getVideoDimensions, calculateCropParams, getVideoDuration } = require('../utils/analyzer');

const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'yt-clipper');

/**
 * Parse a time string (HH:MM:SS, MM:SS, or seconds) to seconds.
 */
function parseTime(timeStr) {
  if (typeof timeStr === 'number') return timeStr;
  timeStr = String(timeStr).trim();

  // Try pure number
  if (/^\d+(\.\d+)?$/.test(timeStr)) return parseFloat(timeStr);

  // Try HH:MM:SS or MM:SS
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];

  throw new Error(`Invalid time format: ${timeStr}. Use HH:MM:SS, MM:SS, or seconds.`);
}

/**
 * Main processing pipeline:
 * 1. Analyze video to find region of interest
 * 2. Cut the requested segment
 * 3. Apply smart crop to 9:16
 * 4. Scale to 1080x1920
 * 5. Encode with H.264
 */
async function processVideo(videoPath, startTime, endTime, jobId, options = {}) {
  const {
    targetWidth = 1080,
    targetHeight = 1920,
    crf = 23,
    preset = 'fast',
    skipAnalysis = false,
    forceCenter = false,
  } = options;

  const jobDir = path.join(TMP_DIR, jobId);
  const outputPath = path.join(jobDir, 'output.mp4');

  // Parse times
  const startSec = parseTime(startTime);
  const endSec = parseTime(endTime);
  const duration = endSec - startSec;

  if (duration <= 0) throw new Error('endTime must be greater than startTime');
  if (duration > 600) throw new Error('Clip duration cannot exceed 10 minutes');

  console.log(`[processor] Processing clip: ${startSec}s - ${endSec}s (${duration.toFixed(1)}s)`);

  // Step 1: Get video dimensions
  const dims = await getVideoDimensions(videoPath);
  console.log(`[processor] Source dimensions: ${dims.width}x${dims.height}`);

  // Step 2: Analyze video for smart crop
  let cropParams;
  if (forceCenter) {
    cropParams = calculateCropParams(dims.width, dims.height, dims.width / 2, targetWidth, targetHeight);
    console.log(`[processor] Using center crop (forced)`);
  } else if (skipAnalysis) {
    cropParams = calculateCropParams(dims.width, dims.height, dims.width / 2, targetWidth, targetHeight);
    console.log(`[processor] Using center crop (analysis skipped)`);
  } else {
    const analysis = await analyzeVideo(videoPath, jobDir, { numFrames: 12 });
    cropParams = calculateCropParams(dims.width, dims.height, analysis.cropCenterX, targetWidth, targetHeight);
    console.log(`[processor] Smart crop: x=${cropParams.cropX}, w=${cropParams.cropWidth} (confidence: ${(analysis.confidence * 100).toFixed(0)}%)`);
  }

  // Step 3: Cut + crop + scale + encode in a single FFmpeg pass
  // Using -ss before -i for fast seeking, then -t for duration
  const ffmpegArgs = [
    '-ss', startSec.toString(),
    '-i', videoPath,
    '-t', duration.toString(),
    '-filter_complex',
    `[0:v]crop=${cropParams.cropWidth}:${cropParams.cropHeight}:${cropParams.cropX}:${cropParams.cropY},scale=${cropParams.scaleWidth}:${cropParams.scaleHeight}:force_original_aspect_ratio=decrease,pad=${cropParams.scaleWidth}:${cropParams.scaleHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', crf.toString(),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-ar', '44100',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];

  console.log(`[processor] Running FFmpeg...`);
  await new Promise((resolve, reject) => {
    const proc = execFile('ffmpeg', ffmpegArgs, {
      timeout: 300_000, // 5 min max processing
      maxBuffer: 5 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`FFmpeg processing failed: ${stderr.slice(-500) || err.message}`));
        return;
      }
      resolve();
    });

    proc.stderr?.on('data', d => {
      const msg = d.toString();
      // Only log key progress info
      if (msg.includes('frame=') || msg.includes('time=') || msg.includes('speed=')) {
        // Progress — only log occasionally
        if (Math.random() < 0.05) {
          process.stderr.write(d);
        }
      } else {
        process.stderr.write(d);
      }
    });
  });

  // Verify output
  const outputStats = await fs.stat(outputPath);
  if (outputStats.size < 1000) {
    throw new Error('Output file is too small — processing may have failed');
  }

  console.log(`[processor] Output: ${(outputStats.size / (1024 * 1024)).toFixed(1)}MB`);

  return outputPath;
}

/**
 * Alternative: process with dynamic panning crop.
 * This creates a smooth pan effect that follows the detected center of interest
 * across the duration of the clip. More expensive but produces more engaging content.
 */
async function processVideoDynamicPan(videoPath, startTime, endTime, jobId, options = {}) {
  const {
    targetWidth = 1080,
    targetHeight = 1920,
    crf = 23,
    preset = 'fast',
    numFrames = 15,
  } = options;

  const jobDir = path.join(TMP_DIR, jobId);
  const outputPath = path.join(jobDir, 'output_dynamic.mp4');

  const startSec = parseTime(startTime);
  const endSec = parseTime(endTime);
  const clipDuration = endSec - startSec;

  if (clipDuration <= 0) throw new Error('endTime must be greater than startTime');

  const dims = await getVideoDimensions(videoPath);
  const cropWidth = Math.round(dims.height * (9 / 16));
  const cropHeight = dims.height;
  const maxX = dims.width - cropWidth;

  // Analyze frames to build a pan keyframe track
  const { analyzeFrame, extractFrames } = require('../utils/analyzer');
  console.log(`[processor-dynamic] Extracting ${numFrames} frames for pan track...`);
  const framesDir = path.join(jobDir, 'pan_frames');
  await fs.mkdir(framesDir, { recursive: true });

  const interval = clipDuration / (numFrames + 1);
  const panKeyframes = [];

  for (let i = 1; i <= numFrames; i++) {
    const timestamp = startSec + interval * i;
    const framePath = path.join(framesDir, `pan_${i.toString().padStart(3, '0')}.jpg`);

    // Extract frame
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-ss', timestamp.toString(),
        '-i', videoPath,
        '-frames:v', '1',
        '-q:v', '5',
        '-y',
        framePath,
      ], { timeout: 15_000 }, (err) => err ? reject(err) : resolve());
    });

    try {
      const centerX = await analyzeFrame(framePath);
      let cropX = Math.round(centerX - cropWidth / 2);
      cropX = Math.max(0, Math.min(cropX, maxX));
      panKeyframes.push({ time: timestamp - startSec, x: cropX });
    } catch (e) {
      console.warn(`[processor-dynamic] Frame ${i} analysis failed: ${e.message}`);
    }
  }

  // Cleanup pan frames
  await fs.rm(framesDir, { recursive: true, force: true });

  if (panKeyframes.length === 0) {
    console.log('[processor-dynamic] No keyframes, falling back to center crop');
    return processVideo(videoPath, startTime, endTime, jobId, { ...options, skipAnalysis: true });
  }

  // Build FFmpeg sendcmd file for dynamic crop
  // Interpolate between keyframes for smooth panning
  const sendCmdPath = path.join(jobDir, 'sendcmd.txt');
  let sendCmd = '';

  for (let i = 0; i < panKeyframes.length; i++) {
    const kf = panKeyframes[i];
    sendCmd += `${(kf.time).toFixed(3)} [crop] x ${kf.x};\n`;
  }

  await fs.writeFile(sendCmdPath, sendCmd);

  // Use sendcmd + crop filter for dynamic panning
  const ffmpegArgs = [
    '-ss', startSec.toString(),
    '-i', videoPath,
    '-t', clipDuration.toString(),
    '-filter_complex',
    `[0:v]sendcmd=f=${sendCmdPath},crop=${cropWidth}:${cropHeight}:x='if(eq(on\,1)\,0\,prev_x)':y=0,scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', crf.toString(),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-ar', '44100',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];

  console.log(`[processor-dynamic] Running FFmpeg with ${panKeyframes.length} pan keyframes...`);
  await new Promise((resolve, reject) => {
    execFile('ffmpeg', ffmpegArgs, { timeout: 300_000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Dynamic panning can fail with complex filter chains, fall back to static
        console.warn(`[processor-dynamic] Dynamic pan failed, falling back to static: ${stderr.slice(-300)}`);
        return processVideo(videoPath, startTime, endTime, jobId, { ...options, skipAnalysis: true })
          .then(resolve)
          .catch(reject);
      }
      resolve();
    });
  });

  return outputPath;
}

module.exports = { processVideo, processVideoDynamicPan, parseTime };