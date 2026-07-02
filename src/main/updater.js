'use strict';

// Auto-update via electron-updater + GitHub Releases.
//
// Active only in a packaged, signed build; a no-op in dev (electron-updater
// has no app bundle to compare signatures against). Squirrel.Mac requires the
// running app and the downloaded update to carry the *same* code signature —
// our self-signed "Misracorder Signing" identity satisfies that, so updates
// apply seamlessly even though friends' Macs don't trust the cert itself.

const { app } = require('electron');

const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // re-check every 3 hours while open
const FIRST_CHECK_DELAY_MS = 8000; // let startup settle before hitting the network

let autoUpdater = null;
let started = false;

function init({ send }) {
  if (started || !app.isPackaged) return;
  started = true;

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    autoUpdater = null; // dependency absent — silently skip
    return;
  }

  autoUpdater.autoDownload = true; // fetch quietly in the background
  autoUpdater.autoInstallOnAppQuit = true; // apply on next quit even if not restarted

  autoUpdater.on('update-available', (info) =>
    send('update:available', { version: info && info.version })
  );
  autoUpdater.on('update-downloaded', (info) =>
    send('update:ready', { version: info && info.version })
  );
  autoUpdater.on('error', (err) =>
    console.error('[updater]', (err && err.message) || err)
  );

  const check = () =>
    autoUpdater
      .checkForUpdates()
      .catch((e) => console.error('[updater] check failed', (e && e.message) || e));

  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS);
}

// Called from the "Restart to update" affordance in the renderer.
function quitAndInstall() {
  if (!autoUpdater) return;
  try {
    autoUpdater.quitAndInstall();
  } catch (e) {
    console.error('[updater] install failed', (e && e.message) || e);
  }
}

module.exports = { init, quitAndInstall };
