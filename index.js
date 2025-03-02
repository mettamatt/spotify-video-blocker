/**************************************************************
 *  Spotify Video Domain Detector (Two-Phase Check)
 **************************************************************/

const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const path = require("path");
const readline = require("readline");

/**************************************************************
 *  Configuration Object
 **************************************************************/
const CONFIG = {
  /**
   * Known domains or partial matches used in request-time checks.
   * (Can be more generic: "video-fa.scdn.co", "video.spotifycdn.com", etc.)
   */
  KNOWN_SPOTIFY_VIDEO_DOMAINS: [
    "video-fa.scdn.co",
    "video.spotifycdn.com",
    "video.akamaized.net",
    "video-ak.cdn.spotify.com",
    "video-fa.sc",
    "video-akpcw.spotifycdn.com",
    "video-akpcw-cdn-spotify-com.akamaized.net",
    "video-ak.cdn.spotify.com.splitter-eip.akadns.net",
    "eip-ntt.video-ak.cdn.spotify.com.akahost.net",
    "video-fa.cdn.spotify.com",
    "video-fa-b.cdn.spotify.com",
  ],

  /**
   * Path segments that strongly indicate actual video data,
   * e.g. "/segments/v1/", "/encodings/", "/profiles/" in the URL path.
   */
  REQUIRED_VIDEO_PATH_SEGMENTS: ["/segments/v1/", "/encodings/", "/profiles/"],

  /**
   * File extensions that typically mean actual video streams: .mp4, .webm, etc.
   */
  VIDEO_EXTENSIONS_REGEX: /\.(mp4|webm|m3u8|mpd)(\?|$)/i,

  /**
   * Accepted video MIME types in the response (Content-Type headers).
   */
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
   * Domains to skip outright (false positives, APIs, etc.).
   * If a request's domain is in SKIP_DOMAINS, we ignore it.
   */
  SKIP_DOMAINS: [
    "api-partner.spotify.com",
    "api.spotify.com",
    "accounts.spotify.com",
    "gue1-spclient.spotify.com",
  ],

  /**
   * Common trackers or analytics domains we might abort early.
   */
  IGNORE_DOMAINS: [
    "sentry.io",
    "cookielaw.org",
    "google-analytics",
    "doubleclick.net",
    "analytics",
    "tracker",
    "telemetry",
    "log.spotify.com",
  ],

  // File Paths
  PATHS: {
    CONFIG_DIR: path.join(__dirname, ".config"),
    COOKIES: () => path.join(CONFIG.PATHS.CONFIG_DIR, "spotify-cookies.json"),
    CREDENTIALS: () => path.join(CONFIG.PATHS.CONFIG_DIR, "credentials.json"),
    VIDEO_DOMAINS: path.join(__dirname, "video_domains.json"),
    VIDEO_DOMAINS_CSV: path.join(__dirname, "video_domains.csv"),
  },
};

/**************************************************************
 *  Global Variables
 **************************************************************/
let browser;
let isShuttingDown = false;
/**
 * A Set of all domains detected so far (that we’ve confirmed
 * are actually hosting video content).
 */
const detectedDomains = new Set();
/**
 * Tracks which domains have been logged in the current session
 * to avoid duplicate messages
 */
const loggedThisSession = new Set();

/**
 * A set of “candidate URLs” that pass the request-time check.
 * We'll confirm them in the response-time check.
 */
const candidateVideoRequests = new Set();

/**************************************************************
 *  Utility Functions
 **************************************************************/
const utils = {
  /**
   * Safely read a JSON file; return defaultValue if file is missing/invalid.
   */
  async readJsonFile(filePath, defaultValue = []) {
    try {
      const content = await fs.readFile(filePath, "utf8").catch(() => null);
      if (!content || !content.trim()) return defaultValue;
      return JSON.parse(content);
    } catch (err) {
      console.error(`Error reading ${filePath}:`, err.message);
      return defaultValue;
    }
  },

  /**
   * Write JSON data directly (no backups, no temp rename).
   */
  async writeJsonFile(filePath, data) {
    try {
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      return true;
    } catch (err) {
      console.error(`Error writing ${filePath}:`, err.message);
      return false;
    }
  },

  /**
   * Request-Time Check: "Is this URL likely to be a Spotify video request?"
   * 1) Known Spotify video domain,
   * 2) Must have certain path segments,
   * 3) Usually a recognized file extension (.mp4, etc.).
   * 4) Not in skip-list (api domains, etc.).
   */
  isLikelyVideoRequest(url) {
    try {
      const parsed = new URL(url);

      // 0) Skip known false-positive domains
      const skipMatch = CONFIG.SKIP_DOMAINS.some((skip) =>
        parsed.hostname.includes(skip)
      );
      if (skipMatch) return false;

      // 1) Must match a known Spotify video domain
      const domainMatch = CONFIG.KNOWN_SPOTIFY_VIDEO_DOMAINS.some((vd) =>
        parsed.hostname.includes(vd)
      );
      if (!domainMatch) return false;

      // 2) Must have known path segments
      const lowerPath = parsed.pathname.toLowerCase();
      const pathHasIndicator = CONFIG.REQUIRED_VIDEO_PATH_SEGMENTS.some((seg) =>
        lowerPath.includes(seg)
      );
      if (!pathHasIndicator) return false;

      // 3) Check for recognized file extension
      if (!CONFIG.VIDEO_EXTENSIONS_REGEX.test(lowerPath)) {
        return false;
      }

      // If all checks pass, it’s “likely” a Spotify video request
      return true;
    } catch (err) {
      // If URL parsing fails or something else, skip
      return false;
    }
  },

  /**
   * Response-Time Check: "Does the HTTP response truly look like a video?"
   * We check status code + "content-type" header.
   */
  isVideoResponse(response) {
    const status = response.status();
    if (status < 200 || status >= 300) {
      // Consider partial content (206) if you see it in your logs
      if (status !== 206) return false;
    }

    const headers = response.headers();
    const contentType = (headers["content-type"] || "").toLowerCase();

    // Must match at least one known video MIME pattern
    const mimeMatch = CONFIG.ACCEPTED_VIDEO_MIME_TYPES.some((m) =>
      contentType.includes(m)
    );
    return mimeMatch;
  },

  /**
   * Simple domain extractor (returns "unknown" on invalid).
   */
  getDomain(url) {
    try {
      return new URL(url).hostname;
    } catch (err) {
      return "unknown";
    }
  },
};

/**************************************************************
 *  Core App Logic
 **************************************************************/
const core = {
  /**
   * Create config dir, load existing domain list, launch browser.
   */
  async init() {
    await this.ensureConfigDir();
    await this.loadExistingDomains();

    console.log("Launching browser...");
    browser = await puppeteer.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // Handle unexpected shutdowns
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("uncaughtException", async (error) => {
      console.error("\nUncaught Exception:", error);
      await shutdown();
    });

    return browser;
  },

  /**
   * Ensure .config folder exists for cookies/credentials.
   */
  async ensureConfigDir() {
    await fs
      .mkdir(CONFIG.PATHS.CONFIG_DIR, { recursive: true })
      .catch((err) => {
        if (err.code !== "EEXIST") {
          console.error("Error creating config directory:", err);
        }
      });
  },

  /**
   * Load any previously detected video domains from JSON.
   */
  // Modified the loadExistingDomains function to add known domains by default

  async loadExistingDomains() {
    const existingList = await utils.readJsonFile(
      CONFIG.PATHS.VIDEO_DOMAINS,
      []
    );
    if (Array.isArray(existingList)) {
      existingList.forEach((d) => detectedDomains.add(d));
      console.log(
        `Loaded ${detectedDomains.size} previously detected domains.`
      );
    }

    // Add all known Spotify video domains to the detected domains set
    CONFIG.KNOWN_SPOTIFY_VIDEO_DOMAINS.forEach((domain) => {
      if (!detectedDomains.has(domain)) {
        detectedDomains.add(domain);
        console.log(`Added known domain to detection list: ${domain}`);
      }
    });

    // Save the updated list immediately
    if (detectedDomains.size > 0) {
      await utils.writeJsonFile(CONFIG.PATHS.VIDEO_DOMAINS, [
        ...detectedDomains,
      ]);
      console.log(
        `Saved ${detectedDomains.size} domains to ${CONFIG.PATHS.VIDEO_DOMAINS}`
      );
    }
  },

  /**
   * If a new domain is found, add to the set & persist.
   */
  async logDomain(domain) {
    if (!domain || domain === "unknown") return;

    // If it's truly new (we've never seen it across all runs):
    if (!detectedDomains.has(domain)) {
      detectedDomains.add(domain);
      console.log(`\nDetected NEW video domain: ${domain}`);

      // Persist new domain to file
      await utils.writeJsonFile(CONFIG.PATHS.VIDEO_DOMAINS, [
        ...detectedDomains,
      ]);
      this.printDomainStats();

      // If it's an old (known) domain, make sure we haven't logged it yet this session
    } else if (!loggedThisSession.has(domain)) {
      console.log(`\nVideo detected from known domain: ${domain}`);
    }

    // In either case, mark this domain as "logged in this session"
    loggedThisSession.add(domain);
  },

  /**
   * Print a simple summary of detected domains so far.
   */
  printDomainStats() {
    console.log(`\nTotal video domains detected: ${detectedDomains.size}`);
    Array.from(detectedDomains)
      .sort()
      .forEach((dom) => console.log(`- ${dom}`));
  },

  /**
   * Export domain list to CSV (one domain per line + a header).
   */
  async exportDomainsCSV() {
    if (!detectedDomains.size) {
      console.log("\nNo video domains detected yet. Nothing to export.");
      return;
    }
    const lines = ["domain", ...Array.from(detectedDomains)];
    await fs.writeFile(CONFIG.PATHS.VIDEO_DOMAINS_CSV, lines.join("\n"));
    console.log(
      `\nExported ${detectedDomains.size} domains to ${CONFIG.PATHS.VIDEO_DOMAINS_CSV}`
    );
  },

  /**
   * Generate a domain-based report in the console.
   */
  generateReport() {
    console.log("\n===== VIDEO DOMAIN REPORT =====");
    console.log(`Total domains: ${detectedDomains.size}`);
    if (!detectedDomains.size) {
      console.log("No domains detected yet.");
      return;
    }
    console.log("Domains:");
    Array.from(detectedDomains)
      .sort()
      .forEach((d) => console.log(`- ${d}`));
    console.log("================================");
  },

  /**
   * Credentials & Cookies (unchanged from your original).
   */
  async saveCredentials(email, password) {
    if (
      await utils.writeJsonFile(CONFIG.PATHS.CREDENTIALS(), { email, password })
    ) {
      console.log("Credentials saved for automatic login");
      return true;
    }
    return false;
  },

  async loadCredentials() {
    return await utils.readJsonFile(CONFIG.PATHS.CREDENTIALS(), null);
  },

  async saveCookies(page) {
    const cookies = await page.cookies();
    if (await utils.writeJsonFile(CONFIG.PATHS.COOKIES(), cookies)) {
      console.log("Session cookies saved for next time");
      return true;
    }
    return false;
  },

  async loadCookies(page) {
    const cookies = await utils.readJsonFile(CONFIG.PATHS.COOKIES());
    if (Array.isArray(cookies) && cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log("Previous session cookies loaded");
      return true;
    }
    return false;
  },
};

/**************************************************************
 *  Puppeteer Page Monitoring (Two-Phase Logic)
 **************************************************************/
async function setupPageMonitoring(page) {
  // Basic environment setup
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  );

  // Geolocation/permissions
  await page.setGeolocation({ latitude: 37.773972, longitude: -122.431297 });
  const context = browser.defaultBrowserContext();
  await context.overridePermissions("https://open.spotify.com", [
    "geolocation",
    "microphone",
    "camera",
    "notifications",
    "background-sync",
    "midi",
    "midi-sysex",
  ]);

  // Handle browser disconnect
  browser.on("disconnected", () => {
    console.error("Browser was unexpectedly disconnected");
    process.exit(1);
  });

  // Crash
  page.on("error", async (error) => {
    console.error("Page crashed:", error);
    await shutdown();
  });

  // Filter console errors
  page.on("console", (message) => {
    if (message.type() === "error") {
      const errorText = message.text();
      const ignored = [
        "EMEError: No supported keysystem was found",
        "vendor~web-player",
        "Failed to load resource: net::ERR_CONNECTION_REFUSED",
        "Failed to load resource: the server responded with a status of 403",
        "sentry.io",
        "cookielaw.org",
        ".akamaized.",
        "cdn.",
        "ingest.sentry",
        "connect-state",
        "Failed to load resource",
      ];
      const shouldIgnore = ignored.some((p) => errorText.includes(p));
      if (!shouldIgnore) {
        console.error("Page error:", errorText);
      }
    }
  });

  // ---------------------------------------------------------
  // 1) REQUEST INTERCEPTION (isLikelyVideoRequest)
  // ---------------------------------------------------------
  await page.setRequestInterception(true);
  let skippedRequests = 0;

  page.on("request", (req) => {
    const url = req.url();

    // Abort or skip known tracking/analytics
    const shouldIgnore = CONFIG.IGNORE_DOMAINS.some((d) => url.includes(d));
    if (shouldIgnore) {
      skippedRequests++;
      if (skippedRequests % 10 === 0) {
        console.log(`Filtered ${skippedRequests} non-essential requests`);
      }
      return req.abort().catch(() => req.continue());
    }

    // If the request passes the domain/path checks, store it as "candidate"
    if (utils.isLikelyVideoRequest(url)) {
      candidateVideoRequests.add(url);
    }

    // Continue
    req.continue().catch(() => {});
  });

  // ---------------------------------------------------------
  // 2) RESPONSE CHECK (isVideoResponse)
  // ---------------------------------------------------------
  page.on("response", async (res) => {
    const url = res.url();
    // If not previously flagged, skip
    if (!candidateVideoRequests.has(url)) {
      return;
    }

    // If the response looks like a video, log the domain
    if (utils.isVideoResponse(res)) {
      const domain = utils.getDomain(url);
      await core.logDomain(domain);
      // (Optional) update UI overlay
      updateUI();
    }

    // Remove from the candidate set so we don't keep it around
    candidateVideoRequests.delete(url);
  });

  // ---------------------------------------------------------
  // Optional UI Overlay
  // ---------------------------------------------------------
  await page.evaluate(() => {
    const infoPanel = document.createElement("div");
    infoPanel.id = "spotify-video-detector";
    infoPanel.style.cssText = `
      position: fixed; 
      top: 10px; 
      right: 10px; 
      background: rgba(0, 0, 0, 0.8);
      color: #1DB954; 
      padding: 10px; 
      border-radius: 5px; 
      z-index: 9999;
      font-family: Arial, sans-serif; 
      font-size: 12px; 
      width: 250px;
    `;
    infoPanel.innerHTML = `
      <div style="text-align: center; font-weight: bold; margin-bottom: 5px;">
        Spotify Video Detector
      </div>
      <div>Status: <span id="detector-status">Active</span></div>
      <div>Video domains found: <span id="domains-found">0</span></div>
      <div style="margin-top: 8px; font-size: 11px;">
        <button id="force-play-btn" style="background: #1DB954; color: white; 
                border: none; padding: 5px 8px; border-radius: 4px; 
                cursor: pointer; margin-right: 5px;">
          Force Play
        </button>
      </div>
    `;
    document.body.appendChild(infoPanel);

    window.updateDomainCount = (count) => {
      const domCount = document.getElementById("domains-found");
      if (domCount) domCount.textContent = count;
    };

    document.getElementById("force-play-btn").addEventListener("click", () => {
      const playButtons = Array.from(
        document.querySelectorAll("button")
      ).filter((btn) => {
        const text = btn.textContent.toLowerCase();
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        return (
          text.includes("play") ||
          aria.includes("play") ||
          btn.classList.contains("play-button") ||
          btn.querySelector('svg[data-testid="play-icon"]')
        );
      });
      if (playButtons.length > 0) {
        console.log(
          `Found ${playButtons.length} play buttons, clicking first...`
        );
        playButtons[0].click();
      } else {
        console.log("No play buttons found");
      }
    });
  });
}

/**************************************************************
 *  Interactive Commands (Keyboard)
 **************************************************************/
function setupInputHandlers() {
  let lastDomainCount = 0;

  // Called whenever we want to refresh the overlay
  global.updateUI = () => {
    const currentCount = detectedDomains.size;
    if (currentCount !== lastDomainCount) {
      lastDomainCount = currentCount;
      if (browser && browser.pages) {
        browser.pages().then((pages) => {
          if (pages.length > 0) {
            pages[0]
              .evaluate((count) => {
                if (window.updateDomainCount) window.updateDomainCount(count);
              }, currentCount)
              .catch(() => {});
          }
        });
      }
    }
  };

  // Listen for keystrokes
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", async (data) => {
    const key = data.toString();

    // 'r' => domain-based report
    if (key === "r") {
      core.generateReport();
    }
    // 'e' => export to CSV
    else if (key === "e") {
      console.log("\nExporting domain list to CSV...");
      await core.exportDomainsCSV();
    }
    // 'q' or Ctrl+C => quit
    else if (key === "q" || key === "\u0003") {
      console.log("\nExiting...");
      await shutdown();
    }

    // Update UI
    updateUI();
  });
}

/**************************************************************
 *  Optional Login Handling (if you need to auto-save credentials)
 **************************************************************/
async function handleLogin(page) {
  await page.goto("https://open.spotify.com", { waitUntil: "networkidle2" });

  const isLoggedIn = await page.evaluate(() => {
    return !document.querySelector('[data-testid="login-button"]');
  });

  if (!isLoggedIn) {
    console.log("Not logged in. Please log in manually.");

    // Poll for login status every 5 seconds
    const checkLoginInterval = setInterval(async () => {
      const nowLoggedIn = await page.evaluate(() => {
        return !document.querySelector('[data-testid="login-button"]');
      });
      if (nowLoggedIn) {
        console.log("Login detected!");
        clearInterval(checkLoginInterval);
        await core.saveCookies(page);
      }
    }, 5000);
  } else {
    console.log("Already logged in!");
    await core.saveCookies(page);
  }
}

/**************************************************************
 *  Graceful Shutdown
 **************************************************************/
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("\nPerforming clean shutdown...");
  try {
    if (browser) {
      console.log("Closing browser...");
      const forceExitTimeout = setTimeout(() => {
        console.error("Browser close timed out, forcing exit...");
        process.exit(1);
      }, 5000);

      await browser.close().catch((err) => {
        console.error("Error closing browser:", err.message);
      });
      clearTimeout(forceExitTimeout);
    }
    console.log("Shutdown complete. Goodbye!");
    process.exit(0);
  } catch (err) {
    console.error("Error during shutdown:", err);
    process.exit(1);
  }
}

/**************************************************************
 *  Main Function
 **************************************************************/
async function run() {
  try {
    await core.init();
    const page = await browser.newPage();

    // If you want to reuse login sessions
    await core.loadCookies(page);

    await setupPageMonitoring(page);
    setupInputHandlers();

    // Prompt login if needed
    await handleLogin(page);

    console.log(
      "Browser is open. Navigate to Spotify podcasts with video content."
    );
    console.log("Interactive commands:");
    console.log("  r - Generate a report of detected video domains");
    console.log("  e - Export domains to CSV");
    console.log("  q - Quit the application");

    // Keep the script alive
    await new Promise(() => {});
  } catch (error) {
    console.error("An error occurred:", error);
    await shutdown();
  }
}

// Start
run();
