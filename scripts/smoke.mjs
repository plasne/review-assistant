import { accessSync, constants, readFileSync } from 'node:fs';

const required = ['dist/main/main.js', 'dist/preload/preload.js', 'dist/renderer/index.html', 'src/generated/version.ts'];

for (const file of required) {
  accessSync(file, constants.R_OK);
}

const main = readFileSync('dist/main/main.js', 'utf8');
const preload = readFileSync('dist/preload/preload.js', 'utf8');
if (!main.includes('contextIsolation') || !main.includes('nodeIntegration') || !main.includes('sandbox')) {
  throw new Error('Smoke check failed: secure Electron webPreferences are missing from built main bundle.');
}

const mainChannels = extractChannels(main, /handle\(\s*"([^"]+)"/g);
const preloadChannels = extractChannels(preload, /invoke\("([^"]+)"/g);
const missingHandlers = [...preloadChannels].filter((channel) => !mainChannels.has(channel));

if (missingHandlers.length > 0) {
  throw new Error(`Smoke check failed: missing ipcMain handlers for ${missingHandlers.join(', ')}.`);
}

const mainEvents = extractChannels(main, /send\(\s*"([^"]+)"/g);
const preloadEvents = unionChannels(extractChannels(preload, /on\(\s*"([^"]+)"/g), extractChannels(preload, /onEvent\(\s*"([^"]+)"/g));
const missingEventSenders = [...preloadEvents].filter((channel) => !mainEvents.has(channel));
const missingEventBridges = [...mainEvents].filter((channel) => !preloadEvents.has(channel));

if (missingEventSenders.length > 0) {
  throw new Error(`Smoke check failed: missing webContents senders for ${missingEventSenders.join(', ')}.`);
}

if (missingEventBridges.length > 0) {
  throw new Error(`Smoke check failed: missing preload event bridges for ${missingEventBridges.join(', ')}.`);
}

console.log('Smoke check passed.');

function extractChannels(content, pattern) {
  const channels = new Set();
  for (const match of content.matchAll(pattern)) {
    channels.add(match[1]);
  }
  return channels;
}

function unionChannels(...sets) {
  const channels = new Set();
  for (const set of sets) {
    for (const channel of set) {
      channels.add(channel);
    }
  }
  return channels;
}
