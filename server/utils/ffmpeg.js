const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function getFfmpegPath() {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) {
    return process.env.FFMPEG_BIN;
  }
  const localBin = path.join(__dirname, "..", "..", "bin", "ffmpeg.exe");
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  const siblingBin = "E:\\Websites\\video_downloader\\bin\\ffmpeg.exe";
  if (fs.existsSync(siblingBin)) {
    return siblingBin;
  }
  return "ffmpeg";
}

// Spawn ffmpeg with the provided arguments.
function runFfmpeg(args, options = {}) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();
    const proc = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stderr });
      } else {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

// Ensure the output is an MP4 container.
async function ensureMp4(inputPath, outputPath) {
  const args = ["-y", "-i", inputPath, "-c", "copy", outputPath];
  await runFfmpeg(args);
}

// Ensure the output is an MP3 container.
async function ensureMp3(inputPath, outputPath) {
  const args = ["-y", "-i", inputPath, "-vn", "-ar", "44100", "-ac", "2", "-b:a", "192k", outputPath];
  await runFfmpeg(args);
}
// Merge separate video and audio files into a single MP4.
async function mergeVideoAudio(videoPath, audioPath, outputPath) {
  const args = ["-y", "-i", videoPath, "-i", audioPath, "-c", "copy", "-shortest", outputPath];
  await runFfmpeg(args);
}

module.exports = {
  getFfmpegPath,
  runFfmpeg,
  ensureMp4,
  ensureMp3,
  mergeVideoAudio,
};