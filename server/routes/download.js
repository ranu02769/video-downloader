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

// Helper to clean up all temporary files matching a download base name
function cleanupFilesByPrefix(prefix, keepFile = null) {
  try {
    if (!fs.existsSync(TEMP_DIR)) return;
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      const fullPath = path.join(TEMP_DIR, file);
      if (file.startsWith(prefix) && fullPath !== keepFile) {
        try {
          fs.unlinkSync(fullPath);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

// Format error message to be helpful
function formatErrorMessage(rawMessage) {
  if (!rawMessage) return "Unable to process the requested video.";

  if (
    rawMessage.includes("Sign in to confirm you’re not a bot") ||
    rawMessage.includes("Sign in to confirm you're not a bot")
  ) {
    return "YouTube Bot Protection: YouTube cloud server ko block kar raha hai. Iska permanent solution 'cookies.txt' lagana hai (1 minute lagta hai). Instagram, Facebook, TikTok, Twitter bina kisi setting ke turant chalte hain.";
  }

  if (rawMessage.includes("Video unavailable") || rawMessage.includes("Private video")) {
    return "This video is private, removed, or unavailable.";
  }

  if (rawMessage.includes("HTTP Error 429")) {
    return "Too many requests to the platform right now. Please wait a minute and try again.";
  }

  return rawMessage;
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
    const userMsg = formatErrorMessage(error.message);
    return res.status(500).json({
      status: "error",
      message: userMsg,
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

    // Clean up any remaining temporary chunks
    cleanupFilesByPrefix(filenameBase, finalOutput);
    scheduleCleanup(finalOutput);

    return res.json({
      status: "success",
      downloadUrl: `/temp/${path.basename(finalOutput)}`,
      filename: `${filenameBase}.${targetExt}`,
      ext: targetExt,
    });
  } catch (error) {
    cleanupFilesByPrefix(filenameBase);

    const userMsg = formatErrorMessage(error.message);
    return res.status(500).json({
      status: "error",
      message: userMsg,
    });
  }
});

module.exports = router;