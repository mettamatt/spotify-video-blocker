/**************************************************************
 *  Spotify Video Domain Detector
 *  Filename: index.js
 **************************************************************/

//==============================================================
//  Imports
//==============================================================
const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const path = require("path");

//==============================================================
//  Configuration
//==============================================================
const CONFIG = {
  // Existing reference video domains
  REFERENCE_VIDEO_DOMAINS: [
    "video-fa.scdn.co",
    "video.spotifycdn.com",
    "video.akamaized.net",
    "video-ak.cdn.spotify.com",
    "video-ak.spotifycdn.com",
    "video-fa.sc",
    "video-akpcw.spotifycdn.com",
    "video-akpcw-cdn-spotify-com.akamaized.net",
    "video-ak.cdn.spotify.com.splitter-eip.akadns.net",
    "eip-ntt.video-ak.cdn.spotify.com.akahost.net",
    "video-fa.cdn.spotify.com",
    "video-fa-b.cdn.spotify.com",
  ],

  // Reference audio domains that sometimes incorrectly have "video/mp4".
  REFERENCE_AUDIO_DOMAINS: [
    "audio-fa.scdn.co",
    "audio.spotifycdn.com",
    "audio.akamaized.net",
    "audio-ak.cdn.spotify.com",
    "audio-ak.spotifycdn.com",
    "audio-akpcw.spotifycdn.com",
    "audio-akpcw-cdn-spotify-com.akamaized.net",
    "audio-ak.cdn.spotify.com.splitter-eip.akadns.net",
    "eip-ntt.audio-ak.cdn.spotify.com.akahost.net",
    "audio-fa.cdn.spotify.com",
    "audio-fa-b.cdn.spotify.com",
  ],

  IGNORED_DOMAINS: [
    "api-partner.spotify.com",
    "api.spotify.com",
    "accounts.spotify.com",
    "gue1-spclient.spotify.com",
    "sentry.io",
    "cookielaw.org",
    "google-analytics",
    "doubleclick.net",
    "analytics",
    "tracker",
    "telemetry",
    "log.spotify.com",
  ],
  DEFINITELY_NON_VIDEO_EXTENSIONS: [
    ".css",
    ".js",
    ".json",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".svg",
    ".woff",
    ".woff2",
    ".ttf",
    ".html",
    ".map",
    ".ico",
  ],
  ACCEPTED_VIDEO_MIME_TYPES: [
    "video/mp4",
    "video/webm",
    "video/ogg",
    "video/",
    "application/x-mpegurl",
    "application/vnd.apple.mpegurl",
    "application/dash+xml",
  ],

  /**
   * Optional size-based fallback threshold for "likely video".
   * Adjust as you see fit or remove this logic if not needed.
   */
  VIDEO_SIZE_THRESHOLD_BYTES: 50 * 1024 * 1024, // 50 MB example

  PATHS: {
    CONFIG_DIR: path.join(__dirname, ".config"),
    COOKIES: path.join(__dirname, ".config", "spotify-cookies.json"),
    VIDEO_DOMAINS: path.join(__dirname, "video_domains.json"),
    VIDEO_DOMAINS_CSV: path.join(__dirname, "video_domains.csv"),
  },
};

//==============================================================
//  Global Variables
//==============================================================
let browser;
let isShuttingDown = false;

// A set of known or newly discovered video-related domains.
const detectedDomains = new Set();

// Known audio domains (excluded from video classification).
const knownAudioDomains = new Set();

// Requests flagged as potential video (checked in response).
const candidateVideoRequests = new Set();

// To avoid re-logging the same known domain multiple times per run.
const loggedThisSession = new Set();

//===
// A simple promise chain to avoid race conditions on writes.
// Each domain write appends to the chain, ensuring no overlap.
//===
let domainWriteQueue = Promise.resolve();

//==============================================================
//  Utility Functions
//==============================================================
const utils = {
  /**
   * Safely read a JSON file, returning a default if not found or invalid.
   */
  async readJsonFile(filePath, defaultValue = []) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      return content ? JSON.parse(content) : defaultValue;
    } catch {
      return defaultValue;
    }
  },

  /**
   * Writes data to a JSON file with pretty formatting.
   * @note The function is used in a promise chain to avoid concurrency issues.
   */
  async writeJsonFile(filePath, data) {
    try {
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`Error writing to ${filePath}: ${err.message}`);
    }
  },

  /**
   * Extract domain from a URL.
   */
  getDomain(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return "unknown";
    }
  },

  /**
   * Checks if a URL points to a known non-video file extension (images, CSS, etc.).
   */
  isDefinitelyNotVideoRequest(url) {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname.toLowerCase();
      return CONFIG.DEFINITELY_NON_VIDEO_EXTENSIONS.some((ext) =>
        pathname.endsWith(ext)
      );
    } catch {
      // If parsing fails, we don't assume it's definitely non-video.
      return false;
    }
  },

  /**
   * Checks if a Puppeteer response likely contains video (based on status + Content-Type).
   */
  isVideoResponse(response) {
    const status = response.status();
    if (status !== 200 && status !== 206) return false;

    const contentType = (
      response.headers()["content-type"] || ""
    ).toLowerCase();
    return CONFIG.ACCEPTED_VIDEO_MIME_TYPES.some((t) =>
      contentType.includes(t)
    );
  },
};

//==============================================================
//  Initialization / Startup
//==============================================================
async function init() {
  try {
     // Ensure config directory exists
     await fs.mkdir(CONFIG.PATHS.CONFIG_DIR, { recursive: true });

     // Load existing video domains
     const existingList = await utils.readJsonFile(CONFIG.PATHS.VIDEO_DOMAINS, []);
     existingList.forEach((dom) => detectedDomains.add(dom));

     // Also add reference video domains
     CONFIG.REFERENCE_VIDEO_DOMAINS.forEach((dom) => detectedDomains.add(dom));

     // Write the combined set back to the JSON file
     await utils.writeJsonFile(CONFIG.PATHS.VIDEO_DOMAINS, [...detectedDomains]);

    console.log(
      `Loaded ${detectedDomains.size} known video domains (existing + reference).`
    );

    // Launch Puppeteer
    browser = await puppeteer.launch({
      headless: false, // set to true if you prefer headless mode
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // Graceful shutdown on Ctrl+C
    process.on("SIGINT", shutdown);
  } catch (err) {
    console.error("Error during initialization:", err.message);
    throw err;
  }
}

//==============================================================
//  Monitoring / Detection
//==============================================================
async function setupPageMonitoring(page) {
  /**
   * Helper to wrap event handlers and catch any thrown errors.
   */
  function wrapEventHandler(handler) {
    return async (...args) => {
      try {
        await handler(...args);
      } catch (error) {
        console.error(`Error in event handler: ${error.message}`);
      }
    };
  }

  await page.setRequestInterception(true);

  // Attach listeners with error wrapping
  page.on("request", wrapEventHandler(handleRequest));
  page.on("response", wrapEventHandler(handleResponse));

  //=== NEW: Clean up candidate requests on request failure/timeouts. ===
  page.on("requestfailed", wrapEventHandler(handleFailedRequest));

  async function handleRequest(req) {
    const requestUrl = req.url();

    // Skip ignored domains
    if (CONFIG.IGNORED_DOMAINS.some((d) => requestUrl.includes(d))) {
      return safelyContinue(req);
    }

    // Skip known non-video resources
    if (utils.isDefinitelyNotVideoRequest(requestUrl)) {
      return safelyContinue(req);
    }

    // Otherwise, mark as candidate
    candidateVideoRequests.add(requestUrl);
    return safelyContinue(req);
  }

  async function handleResponse(res) {
    const url = res.url();

    // Only look at previously flagged requests
    if (!candidateVideoRequests.has(url)) return;

    const domain = utils.getDomain(url);

    // 1) If domain is in knownAudioDomains, skip
    if (knownAudioDomains.has(domain)) {
      candidateVideoRequests.delete(url);
      return;
    }

    // 2) If domain is already known video, label it as video
    if (detectedDomains.has(domain)) {
      if (!loggedThisSession.has(domain)) {
        console.log(`Video detected from known domain: ${domain}`);
      }
      loggedThisSession.add(domain);
      candidateVideoRequests.delete(url);
      return;
    }

    // 3) If it looks like video but is unknown:
    if (utils.isVideoResponse(res)) {
      const contentLength = parseInt(
        res.headers()["content-length"] || "0",
        10
      );

      // If it's above some threshold, assume video; else assume audio
      if (contentLength > CONFIG.VIDEO_SIZE_THRESHOLD_BYTES) {
        console.log(
          `Large content-length (~${contentLength} bytes). Assuming video for domain: ${domain}`
        );
        await logDomain(domain);
      } else {
        knownAudioDomains.add(domain);
        console.log(
          `New domain with "video" MIME but smaller size => Marking as audio: ${domain}`
        );
      }
    }

    candidateVideoRequests.delete(url);
  }

  // NEW: Clean up entries when requests fail or time out
  async function handleFailedRequest(req) {
    const requestUrl = req.url();
    if (candidateVideoRequests.has(requestUrl)) {
      candidateVideoRequests.delete(requestUrl);
    }
  }

  async function safelyContinue(req) {
    try {
      await req.continue();
    } catch (err) {
      // Request might be already handled/aborted; ignore
    }
  }
}

/**
 * Log a newly discovered domain or a known one.
 * Uses domainWriteQueue to avoid concurrency issues with file writes.
 */
async function logDomain(domain) {
  if (!detectedDomains.has(domain)) {
    detectedDomains.add(domain);
    console.log(`NEW video domain detected: ${domain}`);

    // Append a write to our promise chain
    domainWriteQueue = domainWriteQueue.then(() =>
      utils.writeJsonFile(CONFIG.PATHS.VIDEO_DOMAINS, [...detectedDomains])
    );
  } else if (!loggedThisSession.has(domain)) {
    console.log(`Video detected from known domain: ${domain}`);
  }
  loggedThisSession.add(domain);
}

//==============================================================
//  Cookie Management
//==============================================================
async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    await utils.writeJsonFile(CONFIG.PATHS.COOKIES, cookies);
    console.log("Session cookies saved.");
  } catch (error) {
    console.error(`Failed to save cookies: ${error.message}`);
  }
}

async function loadCookies(page) {
  const cookies = await utils.readJsonFile(CONFIG.PATHS.COOKIES, []);
  if (Array.isArray(cookies) && cookies.length > 0) {
    try {
      await page.setCookie(...cookies);
      console.log("Previous session cookies loaded.");
    } catch (err) {
      console.error("Error loading cookies:", err.message);
    }
  }
}

//==============================================================
//  User Login Flow
//==============================================================
async function handleLogin(page) {
  await page.goto("https://open.spotify.com", { waitUntil: "networkidle2" });

  // Check if already logged in
  const isLoggedIn = await page.evaluate(() => {
    return !document.querySelector('[data-testid="login-button"]');
  });

  if (!isLoggedIn) {
    console.log("Not logged in. Please log in manually.");
    // Give the user 5 minutes to log in
    const loginTimeout = setTimeout(() => {
      console.log(
        "Login timeout reached. Please restart if you still need to log in."
      );
    }, 300000);

    // Poll for login every 5 seconds
    const checkLoginInterval = setInterval(async () => {
      const nowLoggedIn = await page.evaluate(() => {
        return !document.querySelector('[data-testid="login-button"]');
      });
      if (nowLoggedIn) {
        console.log("Login detected! Saving cookies...");
        clearInterval(checkLoginInterval);
        clearTimeout(loginTimeout);
        await saveCookies(page);
      }
    }, 5000);
  } else {
    console.log("Already logged in! Saving cookies...");
    await saveCookies(page);
  }
}

//==============================================================
//  User Interaction (Keyboard Commands)
//==============================================================
function setupInputHandlers() {
  process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdin.on("data", (data) => {
    const key = data.toString().toLowerCase();
    if (key === "r") {
      printReport();
    } else if (key === "e") {
      exportDomainsCSV().catch((err) =>
        console.error("Error exporting CSV:", err)
      );
    } else if (key === "q" || key === "\u0003") {
      shutdown().catch((err) => console.error("Error during shutdown:", err));
    }
  });
}

/**
 * Print a list of all detected video domains
 */
function printReport() {
  console.log("\n===== Detected Video Domains =====");
  if (!detectedDomains.size) {
    console.log("No domains detected yet.");
  } else {
    Array.from(detectedDomains)
      .sort()
      .forEach((dom) => console.log(`- ${dom}`));
  }
  console.log("==================================");
}

/**
 * Export the detected domains to a CSV file with quoting to handle commas, etc.
 */
async function exportDomainsCSV() {
  if (!detectedDomains.size) {
    console.log("No video domains detected. Nothing to export.");
    return;
  }

  // Properly quote fields
  const formatCsvField = (field) => `"${field.replace(/"/g, '""')}"`;

  const lines = [formatCsvField("domain")];
  for (const domain of detectedDomains) {
    lines.push(formatCsvField(domain));
  }

  try {
    await fs.writeFile(CONFIG.PATHS.VIDEO_DOMAINS_CSV, lines.join("\n"));
    console.log(
      `Exported ${detectedDomains.size} domains to ${CONFIG.PATHS.VIDEO_DOMAINS_CSV}`
    );
  } catch (err) {
    console.error(`Failed to export CSV: ${err.message}`);
  }
}

//==============================================================
//  Graceful Shutdown
//==============================================================
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("\nShutting down...");

  //=== 1) Remove STDIN listeners so we don't get stuck ===
  process.stdin.removeAllListeners("data");
  process.stdin.setRawMode(false);
  process.stdin.pause();

  //=== 2) If the browser is open, close all pages then close the browser ===
  if (browser) {
    try {
      const pages = await browser.pages();
      await Promise.all(pages.map((p) => p.close()));
      await browser.close();
    } catch (err) {
      console.error("Error closing browser:", err.message);
    }
  }

  //=== 3) Exit the process ===
  process.exit(0);
}

//==============================================================
//  Main Entry Point
//==============================================================
async function run() {
  try {
    await init();
    if (!browser) {
      throw new Error("Browser failed to launch.");
    }

    const page = await browser.newPage();
    await loadCookies(page);
    await setupPageMonitoring(page);
    setupInputHandlers();
    await handleLogin(page);

    console.log(
      "\nBrowser is open. WARNING: Please remain on Spotify while the script runs."
    );
    console.log(
      "Navigate within Spotify (especially podcasts) with potential video content."
    );
    console.log("Interactive commands:");
    console.log("  r - Report detected video domains");
    console.log("  e - Export domains to CSV");
    console.log("  q - Quit the application");
    console.log("----------------------------------");

    // Keep the script alive
    await new Promise(() => {});
  } catch (error) {
    console.error("An error occurred:", error);
    await shutdown();
  }
}

// Start the application
run();
