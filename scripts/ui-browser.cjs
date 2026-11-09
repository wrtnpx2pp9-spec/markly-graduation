'use strict';

// Windows developers can use installed Edge; Linux CI installs Playwright Chromium.
const { chromium } = require('playwright');
async function launchBrowser() {
  const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : '');
  return chromium.launch({ headless: true, ...(channel && channel !== 'chromium' ? { channel } : {}) });
}
module.exports = { launchBrowser };
