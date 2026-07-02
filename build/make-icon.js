'use strict';

// Renders build/icon.html in a transparent 1024×1024 window and writes the
// composited result to build/icon.png, which electron-builder turns into the
// .icns app icon. Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false },
  });
  await win.loadFile(path.join(__dirname, 'icon.html'));
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.toPNG());
  const size = img.getSize();
  console.log(`wrote build/icon.png (${size.width}×${size.height})`);
  app.quit();
});
