# Spotify Video Blocker

A Node.js tool that detects video content domains used by Spotify for podcasts and video content delivery.

## Overview

This tool uses Puppeteer to monitor network requests while you browse Spotify, identifying and logging domains that serve video content. The collected domain list can be used to block unwanted video content, saving bandwidth and improving your Spotify experience.

### Key Features:

- **Two-Phase Detection**: First checks requests based on domain and URL patterns, then verifies responses by content type
- **Domain Logging**: Automatically saves detected video domains to JSON and CSV files
- **Session Management**: Saves and reuses login cookies for convenience
- **Interactive Controls**: Keyboard shortcuts for generating reports and exporting data
- **Smart Filtering**: Distinguishes between video and audio content domains

## Requirements

- Node.js (v12 or higher recommended)
- NPM or Yarn

## Installation

1. Clone this repository:

   ```
   git clone https://github.com/mettamatt/spotify-video-blocker.git
   cd spotify-video-blocker
   ```

2. Install dependencies:
   ```
   npm install
   ```

## Usage

Start the application:

```
npm start
```

or

```
node index.js
```

### First-Time Setup

1. When you first run the application, a browser window will open
2. Log in to your Spotify account
3. The tool will detect your login and save cookies for future use

### Using the Tool

1. Once logged in, navigate to podcasts or other Spotify content with videos
2. The tool will automatically detect video domains as you browse
3. Detected domains are saved to `video_domains.json` and can be exported to CSV

### Keyboard Controls

While the application is running, you can use these keyboard shortcuts:

- `r` - Generate a report of detected video domains in the console
- `e` - Export domains to a CSV file (`video_domains.csv`)
- `q` - Quit the application

## How It Works

### Detection Logic

The tool uses a two-phase approach to identify video content:

1. **Request-Time Check**:

   - Matches against known Spotify video domains
   - Checks for video file extensions
   - Filters out known non-video resources

2. **Response-Time Check**:
   - Validates HTTP status codes
   - Confirms video MIME types in Content-Type headers
   - Uses content-length thresholds to distinguish between audio and video

### Using the Detected Domains

Once you've collected a list of video domains, you can use them to block video content by:

- Adding them to your hosts file
- Configuring your network-level ad blocker (like Pi-hole)
- Using them with browser extensions that block specific domains

## Configuration

The tool includes a comprehensive configuration object in `index.js` that allows you to:

- Add or modify known video domains
- Adjust path segments used for detection
- Update accepted MIME types and file extensions
- Configure domains to skip or ignore

## Troubleshooting

- **Browser doesn't open**: Ensure Puppeteer is installed correctly and you have sufficient permissions
- **No domains detected**: Try navigating to different podcasts or content with video
- **Login issues**: If automatic login fails, you can log in manually in the opened browser window

## File Structure

```
/spotify-video-blocker
├── index.js            # Main application code
├── package.json        # NPM package configuration
├── README.md           # This file
└── video_domains.json  # Detected video domains
```

## License

[MIT License](LICENSE)
