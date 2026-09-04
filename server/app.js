const path = require("path");
const fs = require("fs");

// Ensure local bin directory containing ffmpeg.exe is in process PATH
const binDir = path.join(__dirname, "..", "bin");
if (fs.existsSync(binDir)) {
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
}

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const downloadRoutes = require("./routes/download");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing for API requests.
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Simple per-IP rate limiting for safety.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 10),
  message: {
    status: "error",
    message: "Too many requests. Please wait a minute and try again.",
  },
});

app.use("/api", limiter);
app.use("/api", downloadRoutes);

const publicDir = path.join(__dirname, "..", "public");
const tempDir = path.join(__dirname, "..", "temp");

// Serve temp downloads and frontend assets.
app.use("/temp", express.static(tempDir, { fallthrough: false }));
app.use(express.static(publicDir));

// Explicit SEO routes for search engine crawlers
app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.sendFile(path.join(publicDir, "robots.txt"));
});

app.get("/sitemap.xml", (req, res) => {
  res.type("application/xml");
  res.sendFile(path.join(publicDir, "sitemap.xml"));
});

// Fallback route to the single-page frontend.
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Video downloader running on http://localhost:${PORT}`);
});