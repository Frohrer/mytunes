const { execFile, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SUPPORTED_EXTENSIONS = [
  '.m4r', '.mp3', '.mp4', '.m4a', '.wav', '.aiff', '.aif',
  '.flac', '.ogg', '.wma', '.aac', '.caf', '.mov', '.m4v'
];

const TEMP_DIR = path.join(os.tmpdir(), 'mytunes-conversions');

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

function isSupported(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

function isM4R(filePath) {
  return path.extname(filePath).toLowerCase() === '.m4r';
}

// Add required iTunes metadata atoms so iOS recognizes the ringtone
function addRingtoneMetadata(m4rPath, title) {
  try {
    const scriptPath = path.join(TEMP_DIR, '_add_meta.py');
    fs.writeFileSync(scriptPath, `
import sys
from mutagen.mp4 import MP4
f = MP4(sys.argv[1])
if f.tags is None:
    f.add_tags()
f.tags['\\xa9nam'] = [sys.argv[2]]
f.tags['\\xa9too'] = ['MyTunes 1.0']
f.tags['cpil'] = False
f.tags['pgap'] = False
f.tags['tmpo'] = [0]
f.save()
`);
    execSync(`python3 "${scriptPath}" "${m4rPath}" "${title.replace(/"/g, '\\"')}"`, {
      timeout: 10000
    });
  } catch {
    // Non-fatal - file may still work without metadata on some iOS versions
  }
}

function convertToM4R(inputPath, title) {
  return new Promise((resolve, reject) => {
    ensureTempDir();

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const displayName = title || baseName;
    const outputPath = path.join(TEMP_DIR, `${baseName}.m4r`);

    if (isM4R(inputPath)) {
      // Even for existing m4r files, ensure they have proper metadata
      const tmpCopy = path.join(TEMP_DIR, `${baseName}_copy.m4r`);
      fs.copyFileSync(inputPath, tmpCopy);
      addRingtoneMetadata(tmpCopy, displayName);
      // Also check sample rate and re-encode if not 44100
      try {
        const info = execSync(`afinfo "${tmpCopy}" 2>&1`, { encoding: 'utf8' });
        if (!info.includes('44100 Hz')) {
          // Re-encode to 44100 Hz
          const wavPath = path.join(TEMP_DIR, `${baseName}_resample.wav`);
          execSync(`afconvert "${tmpCopy}" "${wavPath}" -d LEI16@44100 -f WAVE -c 2`, { timeout: 60000 });
          execSync(`afconvert "${wavPath}" "${outputPath}" -d aac -f m4af -s 3`, { timeout: 60000 });
          try { fs.unlinkSync(wavPath); } catch {}
          try { fs.unlinkSync(tmpCopy); } catch {}
          addRingtoneMetadata(outputPath, displayName);
          resolve(outputPath);
          return;
        }
      } catch {}
      // Sample rate is fine, use the copy with metadata
      if (tmpCopy !== outputPath) {
        fs.renameSync(tmpCopy, outputPath);
      }
      resolve(outputPath);
      return;
    }

    // Two-step conversion: resample to 44100 Hz WAV, then encode to AAC m4r
    const intermediateWav = path.join(TEMP_DIR, `${baseName}_intermediate.wav`);

    execFile('afconvert', [
      inputPath,
      intermediateWav,
      '-d', 'LEI16@44100',
      '-f', 'WAVE',
      '-c', '2'
    ], { timeout: 60000 }, (err1) => {
      if (err1) {
        // Fallback: try direct conversion
        execFile('afconvert', [
          inputPath, outputPath,
          '-d', 'aac', '-f', 'm4af', '-s', '3'
        ], { timeout: 60000 }, (err2) => {
          if (err2) {
            tryFfmpeg(inputPath, outputPath).then(() => {
              addRingtoneMetadata(outputPath, displayName);
              resolve(outputPath);
            }).catch(() =>
              reject(new Error(`Failed to convert ${path.basename(inputPath)}: ${err2.message}`))
            );
          } else {
            addRingtoneMetadata(outputPath, displayName);
            resolve(outputPath);
          }
        });
        return;
      }

      // Step 2: WAV 44100Hz → AAC m4r
      execFile('afconvert', [
        intermediateWav,
        outputPath,
        '-d', 'aac',
        '-f', 'm4af',
        '-s', '3'
      ], { timeout: 60000 }, (err2) => {
        try { fs.unlinkSync(intermediateWav); } catch {}

        if (err2) {
          tryFfmpeg(inputPath, outputPath).then(() => {
            addRingtoneMetadata(outputPath, displayName);
            resolve(outputPath);
          }).catch(() =>
            reject(new Error(`Failed to convert ${path.basename(inputPath)}: ${err2.message}`))
          );
        } else {
          addRingtoneMetadata(outputPath, displayName);
          resolve(outputPath);
        }
      });
    });
  });
}

function tryFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-i', inputPath,
      '-vn',
      '-acodec', 'aac',
      '-ar', '44100',
      '-ac', '2',
      '-b:a', '256k',
      '-y',
      outputPath
    ], { timeout: 60000 }, (error) => {
      if (error) reject(error);
      else resolve(outputPath);
    });
  });
}

async function convertAll(filePaths, onProgress) {
  const results = [];

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    const fileName = path.basename(filePath);

    try {
      if (onProgress) onProgress(i, fileName, 'converting');
      const converted = await convertToM4R(filePath);
      results.push({ original: filePath, converted, fileName, success: true });
      if (onProgress) onProgress(i, fileName, 'converted');
    } catch (e) {
      results.push({ original: filePath, converted: null, fileName, error: e.message, success: false });
      if (onProgress) onProgress(i, fileName, 'convert-error');
    }
  }

  return results;
}

function cleanupTemp() {
  try {
    if (fs.existsSync(TEMP_DIR)) {
      const files = fs.readdirSync(TEMP_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(TEMP_DIR, file));
      }
    }
  } catch (e) {
    // Best effort cleanup
  }
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  isSupported,
  isM4R,
  convertToM4R,
  convertAll,
  cleanupTemp
};
