# Spotify Video Domain Detector

A Node.js tool that detects and logs video content domains used by Spotify for podcasts and video content delivery.

## Overview

This tool uses Puppeteer to open a browser window and monitor network requests while you browse Spotify. It implements a two-phase detection system to accurately identify and log domains that serve video content on Spotify.

### Key Features:

- **Two-Phase Detection**: First checks requests based on domain and URL patterns, then verifies responses by content type
- **Domain Logging**: Automatically saves detected video domains to JSON and CSV files
- **Session Management**: Saves and reuses login cookies for convenience
- **Interactive Controls**: Keyboard shortcuts for generating reports and exporting data
- **Visual Overlay**: Shows status and domain count directly in the browser window

## Requirements

- Node.js (v12 or higher recommended)
- NPM or Yarn

## Installation

1. Clone this repository:

   ```
   git clone <repository-url>
   cd spotify-video-domain-detector
   ```

2. Install dependencies:
   ```
   npm install
   ```

## Usage

Start the application:

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
3. A small overlay panel will appear in the top-right corner showing status and domain count
4. Use the "Force Play" button in the overlay to attempt autoplay if needed

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
   - Verifies URL path segments (/segments/v1/, /encodings/, etc.)
   - Checks for video file extensions (.mp4, .webm, etc.)

2. **Response-Time Check**:
   - Validates HTTP status codes
   - Confirms video MIME types in Content-Type headers

### Domain Storage

Detected domains are:

- Stored in memory during runtime
- Saved to `video_domains.json` for persistence
- Exportable to `video_domains.csv` for analysis

## Configuration

The tool comes with a comprehensive configuration object in the code that allows you to:

- Add or modify known video domains
- Adjust path segments used for detection
- Update accepted MIME types and file extensions
- Configure domains to skip or ignore

## Troubleshooting

- **Browser doesn't open**: Ensure Puppeteer is installed correctly and you have sufficient permissions
- **No domains detected**: Try navigating to different podcasts or content with video
- **Login issues**: If automatic login fails, you can log in manually in the opened browser window
