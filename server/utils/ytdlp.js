const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { getFfmpegPath } = require("./ffmpeg");

// Allow overriding the yt-dlp binary via environment variables.
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";

function isMissingBinary(error) {
  return error && (error.code === "ENOENT" || /ENOENT/.test(error.message));
}

function parseCleanError(stderr) {
  if (!stderr) return "yt-dlp execution failed.";
  const lines = stderr.split("\n").map(l => l.trim()).filter(Boolean);
  const errorLines = lines.filter(l => l.startsWith("ERROR:"));
  if (errorLines.length > 0) {
    return errorLines.join(" ");
  }
  const nonWarningLines = lines.filter(l => !l.startsWith("WARNING:"));
  if (nonWarningLines.length > 0) {
    return nonWarningLines.join(" ");
  }
  return lines[lines.length - 1];
}

// Spawn yt-dlp with the provided arguments.
function runYtDlp(args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(parseCleanError(stderr) || `yt-dlp exited with code ${code}`));
      }
    });
  });
}

// Fallback to `python -m yt_dlp` if yt-dlp is not in PATH.
function runYtDlpWithFallback(args, options = {}) {
  return runYtDlp(args, options).catch((error) => {
    if (!isMissingBinary(error)) {
      throw error;
    }

    return new Promise((resolve, reject) => {
      const proc = spawn("python", ["-m", "yt_dlp", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      proc.on("error", (fallbackError) => {
        if (isMissingBinary(fallbackError)) {
          reject(
            new Error(
              "yt-dlp is not installed. Install yt-dlp or set YTDLP_BIN to its path."
            )
          );
          return;
        }
        reject(fallbackError);
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        if (/No module named yt_dlp/i.test(stderr)) {
          reject(
            new Error(
              "Python module yt-dlp is missing. Run: pip install yt-dlp"
            )
          );
          return;
        }

        reject(new Error(parseCleanError(stderr) || `yt-dlp exited with code ${code}`));
      });
    });
  });
}

// Detect supported platform based on the URL.
function detectPlatform(url) {
  if (!url || typeof url !== "string") return "unknown";
  if (/youtu\.be|youtube\.com/i.test(url)) return "youtube";
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/twitter\.com|x\.com/i.test(url)) return "twitter";
  if (/facebook\.com|fb\.watch/i.test(url)) return "facebook";
  if (/reddit\.com|v\.redd\.it/i.test(url)) return "reddit";
  if (/pinterest\.com|pin\.it/i.test(url)) return "pinterest";
  if (/vimeo\.com/i.test(url)) return "vimeo";
  if (/threads\.net/i.test(url)) return "threads";
  
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return "supported";
    }
  } catch (e) {}

  return "unknown";
}

// Helper to retrieve cookie arguments from cookies.txt or YOUTUBE_COOKIES environment variable
function getCookieArgs() {
  const rootCookie = path.join(__dirname, "..", "..", "cookies.txt");
  if (fs.existsSync(rootCookie)) {
    return ["--cookies", rootCookie];
  }
  const tempCookie = path.join(__dirname, "..", "..", "temp", "cookies.txt");
  if (process.env.YOUTUBE_COOKIES) {
    try {
      const tempDir = path.dirname(tempCookie);
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      let cookieData = process.env.YOUTUBE_COOKIES.trim();
      // Handle base64 encoded cookies
      if (!cookieData.includes("\n") && cookieData.length > 100) {
        try {
          const decoded = Buffer.from(cookieData, "base64").toString("utf8");
          if (decoded.includes("# Netscape") || decoded.includes(".youtube.com")) {
            cookieData = decoded;
          }
        } catch (_) {}
      }
      // Handle escaped newlines from environment variables
      if (cookieData.includes("\\n")) {
        cookieData = cookieData.replace(/\\n/g, "\n");
      }
      fs.writeFileSync(tempCookie, cookieData, "utf8");
      return ["--cookies", tempCookie];
    } catch (_) {}
  }
  if (fs.existsSync(tempCookie)) {
    return ["--cookies", tempCookie];
  }
  return [];
}

// Fetch video metadata (title, thumbnail, duration, uploader) without downloading.
async function getVideoInfo(url) {
  const platform = detectPlatform(url);
  const args = [
    "--dump-json",
    "--skip-download",
    "--no-playlist",
    "--no-check-certificates",
    "--geo-bypass",
    "--js-runtimes",
    "node",
  ];

  if (platform === "youtube") {
    const cookieArgs = getCookieArgs();
    if (cookieArgs.length) {
      args.push(...cookieArgs);
    }
  }

  args.push(url);

  const { stdout } = await runYtDlpWithFallback(args);
  const data = JSON.parse(stdout);

  // Format duration into mm:ss or hh:mm:ss
  let durationStr = "N/A";
  if (data.duration) {
    const totalSecs = Math.floor(data.duration);
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hrs > 0) {
      durationStr = `${hrs}:${mins < 10 ? "0" : ""}${mins}:${secs < 10 ? "0" : ""}${secs}`;
    } else {
      durationStr = `${mins}:${secs < 10 ? "0" : ""}${secs}`;
    }
  }

  let directUrl = data.url || null;
  let hdUrl = null;
  let sdUrl = null;

  if (Array.isArray(data.formats)) {
    // Look for HD format
    const hdFormat = data.formats.find(
      (f) => f.format_id === "hd" || (f.height && f.height >= 720) || (f.quality && f.quality === -2)
    );
    if (hdFormat && hdFormat.url) hdUrl = hdFormat.url;

    // Look for SD format
    const sdFormat = data.formats.find(
      (f) => f.format_id === "sd" || (f.height && f.height < 720) || (f.quality && f.quality === -3)
    );
    if (sdFormat && sdFormat.url) sdUrl = sdFormat.url;

    if (!directUrl) {
      const valid = data.formats.filter((f) => f.url && !f.url.includes(".m3u8"));
      if (valid.length > 0) {
        directUrl = valid[valid.length - 1].url;
      }
    }
  }

  if (!hdUrl && directUrl) hdUrl = directUrl;
  if (!sdUrl && directUrl) sdUrl = directUrl;

  return {
    title: data.title || data.fulltitle || (platform === "instagram" ? "Instagram Video" : "Facebook Video"),
    thumbnail: data.thumbnail || (Array.isArray(data.thumbnails) && data.thumbnails.length ? data.thumbnails[data.thumbnails.length - 1].url : ""),
    duration: durationStr,
    uploader: data.uploader || data.channel || data.uploader_id || "Creator",
    platform,
    directUrl,
    hdUrl,
    sdUrl,
  };
}

// Build yt-dlp arguments for video or audio download.
function buildDownloadArgs({ url, outputPath, platform, formatType = "video", quality = "best" }) {
  const ffmpegBinPath = getFfmpegPath();
  const args = [
    "--no-playlist",
    "--restrict-filenames",
    "--no-check-certificates",
    "--geo-bypass",
    "--js-runtimes",
    "node",
    "-N",
    "4", // Multi-threading: Download stream fragments concurrently
    "--buffer-size",
    "1M", // 1MB buffer for smoother disk I/O
    "--no-mtime", // Skip querying remote file timestamps
    "--extractor-retries",
    "3",
    "--fragment-retries",
    "3",
    "-S",
    "res,ext:mp4:m4a", // Prefer MP4 video + M4A audio to allow instant FFmpeg direct-copy muxing without re-encoding
  ];

  if (platform === "youtube") {
    const cookieArgs = getCookieArgs();
    if (cookieArgs.length) {
      args.push(...cookieArgs);
    }
  }

  if (ffmpegBinPath) {
    args.push("--ffmpeg-location", ffmpegBinPath);
  }

  if (formatType === "audio" || quality === "mp3") {
    args.push(
      "-f",
      "bestaudio/best",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "-o",
      outputPath
    );
  } else {
    let formatSpec = "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best";
    if (quality === "1080p") {
      formatSpec = "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best";
    } else if (quality === "720p") {
      formatSpec = "bestvideo[height<=720]+bestaudio/best[height<=720]/best";
    } else if (quality === "480p") {
      formatSpec = "bestvideo[height<=480]+bestaudio/best[height<=480]/best";
    }

    args.push(
      "-f",
      formatSpec,
      "--merge-output-format",
      "mp4",
      "-o",
      outputPath
    );
  }

  if (platform === "tiktok") {
    args.push(
      "--extractor-args",
      "tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com"
    );
  }

  args.push(url);
  return args;
}

module.exports = {
  runYtDlp,
  runYtDlpWithFallback,
  detectPlatform,
  getVideoInfo,
  buildDownloadArgs,
  getCookieArgs,
};