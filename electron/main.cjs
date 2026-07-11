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

  try {
    const body = JSON.parse(text);
    if (typeof body === 'string') return parseControlPayload(body);
    if (body?.status === 'disabled') {
      return {
        status: 'disabled',
        message: String(body.message || 'Cette installation a été désactivée par l’administrateur.'),
      };
    }
    if (body?.status === 'active') return { status: 'active' };
    throw new Error('Invalid JSON control status');
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }

  const [command, ...messageParts] = text.split(/\r?\n/);
  const normalized = command.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (['active', 'enabled', 'enable', 'keep working', 'keep'].includes(normalized)) {
    return { status: 'active' };
  }
  if (['disabled', 'disable', 'inactive', 'stop', 'blocked'].includes(normalized)) {
    return {
      status: 'disabled',
      message: messageParts.join('\n').trim() || 'Cette installation a été désactivée par l’administrateur.',
    };
  }
  throw new Error(`Unknown control command: ${command}`);
}

async function readControlSource(source) {
  if (/^file:/i.test(source)) return fs.readFile(new URL(source), 'utf8');
  if (!/^https?:/i.test(source)) return fs.readFile(path.resolve(source), 'utf8');

  const endpoint = new URL(source);
  if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname)) {
    throw new Error('Remote control endpoint must use HTTPS.');
  }
  const response = await fetch(endpoint, {
    headers: { 'accept': 'application/json, text/plain', 'user-agent': `JournalPro/${app.getVersion()}` },
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function getControlStatus() {
  if (!CONTROL_ENDPOINT) return readCachedControlStatus();
  try {
    const status = parseControlPayload(await readControlSource(CONTROL_ENDPOINT));
    await saveControlStatus(status);
    return status;
  } catch (error) {
    console.warn('Remote control check failed; using last saved status.', error.message);
    return readCachedControlStatus();
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
