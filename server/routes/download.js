const express = require("express");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
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

// Schedule auto-cleanup for downloaded files.
function scheduleCleanup(filePath) {
  const ttlMs = CLEANUP_MINUTES * 60 * 1000;
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (_) {}
  }, ttlMs);
}

// Format error message to be helpful
function formatErrorMessage(rawMessage) {
  if (!rawMessage) return "Unable to process the requested video.";

  if (
    rawMessage.includes("Sign in to confirm you’re not a bot") ||
    rawMessage.includes("Sign in to confirm you're not a bot")
  ) {
    return "Bot Protection: Cloud server ko access nahi mil raha. Please try Facebook or Instagram links.";
  }

  if (rawMessage.includes("Instagram API is not granting access") || rawMessage.includes("empty media response")) {
    return "Instagram post private hai ya unavailable hai. Kripya public Instagram Reel/Video link daalein.";
  }

  if (rawMessage.includes("Video unavailable") || rawMessage.includes("Private video")) {
    return "This video is private, removed, or unavailable.";
  }

  if (rawMessage.includes("HTTP Error 429")) {
    return "Too many requests. Please wait a minute and try again.";
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
      message: "Unsupported link. Please paste an Instagram or Facebook video/reel link.",
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

// ZERO-MEMORY & ZERO-DISK STREAMING DOWNLOAD ENDPOINT
// Pipes direct CDN stream to the client's mobile/browser with Content-Disposition: attachment
router.get("/stream", (req, res) => {
  const { url: mediaUrl, title, platform = "video" } = req.query;

  if (!mediaUrl || typeof mediaUrl !== "string" || !isValidUrl(mediaUrl)) {
    return res.status(400).send("Invalid or missing media stream URL.");
  }

  const cleanTitle = (title || `${platform}_video`)
    .replace(/[^a-zA-Z0-9_\-\s]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .substring(0, 100) || `${platform}_video`;

  const filename = `${cleanTitle}.mp4`;

  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "no-cache");

  const client = mediaUrl.startsWith("https") ? https : http;
  const referer = platform === "instagram" ? "https://www.instagram.com/" : "https://www.facebook.com/";

  const proxyReq = client.get(
    mediaUrl,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: referer,
        Accept: "*/*",
      },
    },
    (remoteRes) => {
      // Follow redirect if 301/302
      if (remoteRes.statusCode >= 300 && remoteRes.statusCode < 400 && remoteRes.headers.location) {
        return res.redirect(remoteRes.headers.location);
      }

      if (remoteRes.headers["content-length"]) {
        res.setHeader("Content-Length", remoteRes.headers["content-length"]);
      }

      // Stream directly to user's device in 64KB chunks (Zero RAM / Zero Disk!)
      remoteRes.pipe(res);
    }
  );

  proxyReq.on("error", () => {
    // If direct piping encounters network issue, redirect to media URL as fallback
    res.redirect(mediaUrl);
  });

  req.on("close", () => {
    proxyReq.destroy();
  });
});

// Main download endpoint
router.post("/download", async (req, res) => {
  const { url, formatType = "video", quality = "best" } = req.body || {};

  if (!url || typeof url !== "string" || !isValidUrl(url)) {
    return res.status(400).json({
      status: "error",
      message: "Please provide a valid public video URL.",
    });
  }

  const platform = detectPlatform(url);

  try {
    const info = await getVideoInfo(url);
    const cleanTitle = (info.title || `${platform}_video`)
      .replace(/[^a-zA-Z0-9_\-\s]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .substring(0, 80) || `${platform}_video`;

    // Pick best available direct CDN stream URL
    let targetStreamUrl = null;
    if (quality === "sd" && info.sdUrl) {
      targetStreamUrl = info.sdUrl;
    } else if (info.hdUrl) {
      targetStreamUrl = info.hdUrl;
    } else if (info.directUrl) {
      targetStreamUrl = info.directUrl;
    }

    // ZERO-RAM / ZERO-DISK JUGAAD:
    // If a direct stream URL is found (Facebook, Instagram, etc.), DO NOT download to server disk!
    // Send direct CDN URL and our lightweight zero-memory streaming pipe!
    if (targetStreamUrl && (formatType !== "audio")) {
      const streamDownloadUrl = `/api/stream?url=${encodeURIComponent(targetStreamUrl)}&title=${encodeURIComponent(cleanTitle)}&platform=${platform}`;

      return res.json({
        status: "success",
        directUrl: targetStreamUrl,
        downloadUrl: streamDownloadUrl,
        filename: `${cleanTitle}.mp4`,
        ext: "mp4",
        info,
      });
    }

    // Fallback for audio conversion or non-direct stream: download minimally
    const isAudio = formatType === "audio" || quality === "mp3";
    const targetExt = isAudio ? "mp3" : "mp4";
    const filenameBase = `${platform}-${uuidv4()}`;
    const rawOutputPattern = path.join(TEMP_DIR, `${filenameBase}.%(ext)s`);
    const finalOutput = path.join(TEMP_DIR, `${filenameBase}.${targetExt}`);

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

    cleanupFilesByPrefix(filenameBase, finalOutput);
    scheduleCleanup(finalOutput);

    return res.json({
      status: "success",
      downloadUrl: `/temp/${path.basename(finalOutput)}`,
      filename: `${filenameBase}.${targetExt}`,
      ext: targetExt,
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

module.exports = router;