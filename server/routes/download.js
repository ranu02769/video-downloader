const express = require("express");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const {
  runYtDlpWithFallback,
  detectPlatform,
  getVideoInfo,
  buildDownloadArgs,
} = require("../utils/ytdlp");
const { ensureMp4, ensureMp3 } = require("../utils/ffmpeg");

const router = express.Router();

const TEMP_DIR = path.join(__dirname, "..", "..", "temp");
const CLEANUP_MINUTES = Number(process.env.CLEANUP_MINUTES || 15);

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Validate incoming URLs for basic safety.
function isValidUrl(input) {
  try {
    const url = new URL(input);
    return ["http:", "https:"].includes(url.protocol);
  } catch (error) {
    return false;
  }
}

// Schedule auto-cleanup for downloaded files.
function scheduleCleanup(filePath) {
  const ttlMs = CLEANUP_MINUTES * 60 * 1000;
  setTimeout(() => {
    fs.unlink(filePath, () => {});
  }, ttlMs);
}

// Fetch Video Info endpoint.
router.post("/info", async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== "string" || !isValidUrl(url)) {
    return res.status(400).json({
      status: "error",
      message: "Please provide a valid public video URL.",
    });
  }

  const platform = detectPlatform(url);
  if (platform === "unknown") {
    return res.status(400).json({
      status: "error",
      message: "Unsupported platform. Paste a link from YouTube, Instagram, TikTok, Twitter/X, Facebook, Reddit, etc.",
    });
  }

  try {
    const info = await getVideoInfo(url);
    return res.json({
      status: "success",
      info,
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message || "Could not fetch video information. Make sure the video is public.",
    });
  }
});

// Main download endpoint.
router.post("/download", async (req, res) => {
  const { url, formatType = "video", quality = "best" } = req.body || {};

  if (!url || typeof url !== "string" || !isValidUrl(url)) {
    return res.status(400).json({
      status: "error",
      message: "Please provide a valid public video URL.",
    });
  }

  const platform = detectPlatform(url);
  if (platform === "unknown") {
    return res.status(400).json({
      status: "error",
      message: "Unsupported platform.",
    });
  }

  const isAudio = formatType === "audio" || quality === "mp3";
  const targetExt = isAudio ? "mp3" : "mp4";
  const filenameBase = `${platform}-${uuidv4()}`;
  const rawOutputPattern = path.join(TEMP_DIR, `${filenameBase}.%(ext)s`);
  const finalOutput = path.join(TEMP_DIR, `${filenameBase}.${targetExt}`);

  try {
    const args = buildDownloadArgs({
      url,
      outputPath: rawOutputPattern,
      platform,
      formatType,
      quality,
    });
    await runYtDlpWithFallback(args, { cwd: TEMP_DIR });

    let downloadedFile = fs.existsSync(finalOutput) ? finalOutput : null;
    if (!downloadedFile) {
      downloadedFile = fs
        .readdirSync(TEMP_DIR)
        .map((file) => path.join(TEMP_DIR, file))
        .filter((file) => !file.endsWith(".part"))
        .find((file) => path.basename(file).startsWith(filenameBase));
    }

    if (!downloadedFile || !fs.existsSync(downloadedFile)) {
      throw new Error("Download failed. File was not generated.");
    }

    if (downloadedFile !== finalOutput) {
      if (isAudio) {
        await ensureMp3(downloadedFile, finalOutput);
      } else {
        await ensureMp4(downloadedFile, finalOutput);
      }
      try {
        fs.unlinkSync(downloadedFile);
      } catch (e) {}
    }

    // Clean up any remaining temporary leftover chunks for this download
    try {
      const remainingFiles = fs.readdirSync(TEMP_DIR);
      for (const file of remainingFiles) {
        const fullPath = path.join(TEMP_DIR, file);
        if (file.startsWith(filenameBase) && fullPath !== finalOutput) {
          fs.unlinkSync(fullPath);
        }
      }
    } catch (e) {}

    scheduleCleanup(finalOutput);

    return res.json({
      status: "success",
      downloadUrl: `/temp/${path.basename(finalOutput)}`,
      filename: `${filenameBase}.${targetExt}`,
      ext: targetExt,
    });
  } catch (error) {
    // If download failed, clean up any leftover partial files for this session
    try {
      const remainingFiles = fs.readdirSync(TEMP_DIR);
      for (const file of remainingFiles) {
        if (file.startsWith(filenameBase)) {
          fs.unlinkSync(path.join(TEMP_DIR, file));
        }
      }
    } catch (e) {}

    return res.status(500).json({
      status: "error",
      message: error.message || "Unable to download the requested media.",
    });
  }
});

module.exports = router;