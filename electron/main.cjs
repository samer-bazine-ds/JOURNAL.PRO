const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

// Vite loads .env only for its renderer. Load main-process settings here.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const CONTROL_ENDPOINT = process.env.JOURNALPRO_CONTROL_ENDPOINT || '';
const CONTROL_TIMEOUT_MS = 8000;

function controlCachePath() {
  return path.join(app.getPath('userData'), 'control-status.json');
}

function controlLogPath() { return path.join(app.getPath('userData'), 'control.log'); }

function safeControlSource(source) {
  try {
    const url = new URL(source);
    url.search = url.search ? '?[REDACTED]' : '';
    url.username = url.username ? '[REDACTED]' : '';
    url.password = url.password ? '[REDACTED]' : '';
    return url.toString();
  } catch { return path.resolve(source); }
}

async function controlLog(event, details = {}) {
  const entry = JSON.stringify({ time: new Date().toISOString(), event, ...details });
  console.log(`[JournalPro control] ${entry}`);
  try {
    await fs.mkdir(path.dirname(controlLogPath()), { recursive: true });
    await fs.appendFile(controlLogPath(), `${entry}\n`, 'utf8');
  } catch (error) { console.warn('[JournalPro control] Could not write control.log:', error.message); }
}

async function readCachedControlStatus() {
  try {
    const cached = JSON.parse(await fs.readFile(controlCachePath(), 'utf8'));
    if (cached?.status === 'disabled') {
      return {
        status: 'disabled',
        message: String(cached.message || 'Cette installation a été désactivée par l’administrateur.'),
      };
    }
    return { status: 'active' };
  } catch {
    return { status: 'active' };
  }
}

async function saveControlStatus(status) {
  const file = controlCachePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...status, checkedAt: new Date().toISOString() }), 'utf8');
}

function parseControlPayload(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Empty control response');

  const [command, ...messageParts] = text.split(/\r?\n/);
  const normalized = command.trim().toLowerCase();
  if (normalized === 'active') return { status: 'active' };
  if (normalized === 'desactive') {
    return {
      status: 'disabled',
      message: messageParts.join('\n').trim() || 'Cette installation a été désactivée par l’administrateur.',
    };
  }
  throw new Error(`Invalid GitHub control content: expected "active" or "desactive", received "${command}"`);
}

function normalizeGitHubFileUrl(source) {
  const endpoint = new URL(source);
  if (endpoint.protocol !== 'https:') throw new Error('GitHub control URL must use HTTPS.');
  if (endpoint.hostname === 'raw.githubusercontent.com') return endpoint;
  if (endpoint.hostname === 'github.com') {
    const match = endpoint.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|edit)\/([^/]+)\/(.+)$/);
    if (!match) throw new Error('GitHub URL must point to a repository file using the /blob/ or /edit/ format.');
    return new URL(`https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`);
  }
  throw new Error(`Control URL host is not allowed: ${endpoint.hostname}`);
}

async function readControlSource(source) {
  const endpoint = normalizeGitHubFileUrl(source);
  const response = await fetch(endpoint, {
    headers: { 'accept': 'text/plain', 'user-agent': `JournalPro/${app.getVersion()}` },
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { content: await response.text(), sourceType: 'github-file', requestedUrl: safeControlSource(endpoint.toString()), httpStatus: response.status };
}

async function getControlStatus() {
  const checkId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await controlLog('check-start', { checkId, configured: Boolean(CONTROL_ENDPOINT), source: CONTROL_ENDPOINT ? safeControlSource(CONTROL_ENDPOINT) : null, logFile: controlLogPath() });
  if (!CONTROL_ENDPOINT) {
    const cached = await readCachedControlStatus();
    await controlLog('decision', { checkId, status: cached.status, reason: 'no-endpoint-configured; using-cache' });
    return cached;
  }
  try {
    const result = await readControlSource(CONTROL_ENDPOINT);
    await controlLog('response', { checkId, sourceType: result.sourceType, requestedUrl: result.requestedUrl, httpStatus: result.httpStatus, content: result.content.slice(0, 4096), truncated: result.content.length > 4096 });
    const status = parseControlPayload(result.content);
    await controlLog('parse-success', { checkId, parsedStatus: status.status, message: status.message || null });
    await saveControlStatus(status);
    await controlLog('cache-updated', { checkId, cacheFile: controlCachePath(), status: status.status });
    await controlLog('decision', { checkId, status: status.status, reason: 'valid-source-response' });
    return status;
  } catch (error) {
    await controlLog('check-error', { checkId, error: error.message, stack: error.stack || null });
    const cached = await readCachedControlStatus();
    await controlLog('decision', { checkId, status: cached.status, reason: 'request-or-parse-failed; using-cache' });
    return cached;
  }
}

ipcMain.handle('control:get-status', getControlStatus);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1050, minHeight: 700,
    backgroundColor: '#0b1120', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  if (!app.isPackaged) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}
app.whenReady().then(() => { createWindow(); app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow()); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
