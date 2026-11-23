# Comments to Markdown (Google Apps Script Web App)

[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![AI-built](https://img.shields.io/badge/ai-built%20with%20copilot-a08bff)

This tool exports **open Google Docs comment threads** to Markdown.
It uses the Drive API for comment data and document title, and orders threads by their position in the document (with fallback to creation order when needed).

## How to use

1. Open the deployed web app URL.
2. Paste a Google Docs URL you can access.
3. Click **Extract** (or press Enter).
4. Copy the generated Markdown from the output box using **Copy to clipboard**.

Notes:

- If there are no open comments, the output is: `No open comments found.`
- Invalid URLs show: `That doesn't look like a Google Docs URL.`

## Updating the app

1. Edit `Code.gs`, `index.html`, and/or `appsscript.json` in the Apps Script project.
2. Save changes.
3. Deploy the update:
   - **Deploy → Manage deployments**
   - Open the existing web app deployment
   - Click **Edit** (pencil icon)
   - Select **New version**
   - Click **Deploy**
4. Use the same web app URL (bookmarkable URL stays the same for that deployment).

## Standalone project setup (first time)

1. Create a standalone Apps Script project at `script.google.com`.
2. Add files: `Code.gs`, `index.html`, `appsscript.json`.
3. Enable **Drive API (Advanced Google services)** with identifier `Drive` (v3).
4. Run a server function once from the editor to authorize scopes.
5. Create web app deployment via **Deploy → New deployment → Web app**.
