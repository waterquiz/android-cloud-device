/**
 * Android Cloud Device Management & Control Server
 *
 * Responsibilities:
 * - Listens on 0.0.0.0:$PORT (compatible with Railway dynamic PORT)
 * - Exposes /health endpoint returning HTTP 200 for Railway deployment checks
 * - Implements authentication via ACCESS_TOKEN
 * - Manages Android lifecycle (start, stop, restart, status checks)
 * - Safe APK upload, magic-byte validation, installation, and launch
 * - Bidirectional WebSocket VNC proxy for remote screen interaction
 * - Hardware key inputs and touch/mouse/keyboard handling
 * - Clean SIGTERM/SIGINT shutdown handling
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const Busboy = require('busboy');

// Load environment and device configuration
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = '0.0.0.0';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'Fraz1234';
const DATA_DIR = process.env.DATA_DIR || '/data';
const APK_DIR = path.join(DATA_DIR, 'apks');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const STATE_FILE = path.join(DATA_DIR, 'android', 'device_state');
const VNC_PORT = parseInt(process.env.VNC_PORT || '5900', 10);
const ADB_PORT = parseInt(process.env.ADB_PORT || '5555', 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '250', 10);
const ALLOW_SOFTWARE_EMULATION = (process.env.ALLOW_SOFTWARE_EMULATION || 'true').toLowerCase() === 'true';

// Ensure directories exist
for (const dir of [DATA_DIR, APK_DIR, LOGS_DIR, path.join(DATA_DIR, 'android')]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    // Ignored if exists
  }
}

// In-memory diagnostic and state tracker
let androidProcess = null;
let lastDiagnostic = 'Initializing Android Cloud Device manager...';

/**
 * Execute a command safely using execFile (avoids shell injection)
 */
function execCommand(file, args, options = {}) {
  return new Promise((resolve) => {
    const defaultTimeout = options.timeout || 3000;
    execFile(file, args, { timeout: defaultTimeout, ...options }, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code || 1) : 0,
        stdout: (stdout || '').toString().trim(),
        stderr: (stderr || '').toString().trim(),
        error: error ? error.message : null
      });
    });
  });
}

/**
 * Check if hardware virtualization (/dev/kvm) is available
 */
function checkKvmAvailability() {
  try {
    const exists = fs.existsSync('/dev/kvm');
    if (!exists) return false;
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Get device status details
 */
async function getDeviceStatus() {
  const kvm = checkKvmAvailability();

  // Read state file if present
  let state = 'STOPPED';
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = fs.readFileSync(STATE_FILE, 'utf8').trim();
    } catch (e) {
      state = 'UNKNOWN';
    }
  }

  // Check ADB connection
  const adbStateRes = await execCommand('adb', ['-s', `127.0.0.1:${ADB_PORT}`, 'get-state'], { timeout: 2000 });
  const adbConnected = adbStateRes.stdout === 'device';

  let bootCompleted = false;
  if (adbConnected) {
    const bootRes = await execCommand('adb', ['-s', `127.0.0.1:${ADB_PORT}`, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 2000 });
    bootCompleted = bootRes.stdout === '1';
    if (bootCompleted) {
      state = 'RUNNING';
    } else {
      state = 'BOOTING';
    }
  } else if (state === 'RUNNING') {
    state = 'OFFLINE';
  }

  let diagnostic = lastDiagnostic;
  if (state === 'CRASHED') {
    const emuLog = path.join(LOGS_DIR, 'emulator.log');
    if (fs.existsSync(emuLog)) {
      try {
        const lines = fs.readFileSync(emuLog, 'utf8').trim().split('\n').filter(Boolean);
        diagnostic = lines.slice(-3).join(' | ') || 'QEMU emulator exited unexpectedly.';
      } catch (e) {}
    }
  }

  // Read disk usage
  let diskUsage = { freeMb: 0, totalMb: 0 };
  try {
    if (fs.statfsSync) {
      const stats = fs.statfsSync(DATA_DIR);
      diskUsage.freeMb = Math.round((stats.bavail * stats.bsize) / (1024 * 1024));
      diskUsage.totalMb = Math.round((stats.blocks * stats.bsize) / (1024 * 1024));
    }
  } catch (e) {
    // Disk info fallback
  }

  return {
    state,
    kvm_available: kvm,
    allow_software_emulation: ALLOW_SOFTWARE_EMULATION,
    adb_connected: adbConnected,
    boot_completed: bootCompleted,
    uptime_seconds: Math.round(process.uptime()),
    disk_usage: diskUsage,
    diagnostic: lastDiagnostic,
    auth_enabled: Boolean(ACCESS_TOKEN)
  };
}

/**
 * Verify authentication token
 */
function isAuthorized(req) {
  if (!ACCESS_TOKEN) return true;

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    if (authHeader.slice(7) === ACCESS_TOKEN) return true;
  }

  const customHeader = req.headers['x-access-token'];
  if (customHeader && customHeader === ACCESS_TOKEN) return true;

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const tokenParam = reqUrl.searchParams.get('token');
  if (tokenParam && tokenParam === ACCESS_TOKEN) return true;

  return false;
}

/**
 * Handle HTTP requests
 */
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // Set default CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-access-token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Health check endpoint (MUST return 200 for Railway container deployment)
  if (pathname === '/health') {
    const kvm = checkKvmAvailability();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'android-cloud-device',
      kvm_available: kvm,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // 2. Serve static frontend files without blocking on auth so the login/token modal can render
  if (req.method === 'GET' && !pathname.startsWith('/api/')) {
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    
    // Path traversal protection
    const publicDir = path.resolve(path.join(__dirname, 'public'));
    const safePath = path.resolve(filePath);
    if (!safePath.startsWith(publicDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Access Denied');
      return;
    }

    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      const ext = path.extname(safePath).toLowerCase();
      const contentTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
      };
      res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
      fs.createReadStream(safePath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // 3. Authenticate API requests
  if (!isAuthorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized. Invalid or missing ACCESS_TOKEN.' }));
    return;
  }

  // 4. API Endpoints
  try {
    // GET /api/device/status
    if (req.method === 'GET' && pathname === '/api/device/status') {
      const status = await getDeviceStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    // POST /api/device/restart
    if (req.method === 'POST' && pathname === '/api/device/restart') {
      lastDiagnostic = 'Device restart requested by user.';
      // Connect to ADB and request reboot if available
      await execCommand('adb', ['-s', `127.0.0.1:${ADB_PORT}`, 'reboot']);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Restart triggered.' }));
      return;
    }

    // POST /api/device/input/key
    if (req.method === 'POST' && pathname === '/api/device/input/key') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const keyMap = {
            'HOME': 3,
            'BACK': 4,
            'APP_SWITCH': 187,
            'POWER': 26,
            'VOLUME_UP': 24,
            'VOLUME_DOWN': 25
          };
          const keycode = keyMap[data.key] || parseInt(data.key, 10);
          if (isNaN(keycode)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid key' }));
            return;
          }
          await execCommand('adb', ['-s', `127.0.0.1:${ADB_PORT}`, 'shell', 'input', 'keyevent', String(keycode)]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, keycode }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid payload' }));
        }
      });
      return;
    }

    // POST /api/device/input/text
    if (req.method === 'POST' && pathname === '/api/device/input/text') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          if (typeof data.text !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'text is required' }));
            return;
          }
          // Escape text for adb input
          const escaped = data.text.replace(/([^a-zA-Z0-9])/g, '\\$1');
          await execCommand('adb', ['-s', `127.0.0.1:${ADB_PORT}`, 'shell', 'input', 'text', escaped]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid payload' }));
        }
      });
      return;
    }

    // GET /api/apks/installed
    if (req.method === 'GET' && pathname === '/api/apks/installed') {
      const pmRes = await execCommand('adb', ['-s', `127.0.0.1:${ADB_PORT}`, 'shell', 'pm', 'list', 'packages', '-3']);
      const packages = [];
      if (pmRes.stdout) {
        const lines = pmRes.stdout.split(/\r?\n/);
        for (const line of lines) {
          if (line.startsWith('package:')) {
            const pkg = line.replace('package:', '').trim();
            if (pkg) {
              packages.push({ packageName: pkg });
            }
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ packages }));
      return;
    }

    // POST /api/apks/launch
    if (req.method === 'POST' && pathname === '/api/apks/launch') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const pkg = data.packageName;
          // Validate package name strictly
          if (!pkg || !/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(pkg)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid package name format' }));
            return;
          }

          // Launch via monkey intent launcher
          const launchRes = await execCommand('adb', [
            '-s', `127.0.0.1:${ADB_PORT}`,
            'shell', 'monkey',
            '-p', pkg,
            '-c', 'android.intent.category.LAUNCHER',
            '1'
          ]);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            output: launchRes.stdout || launchRes.stderr
          }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid payload' }));
        }
      });
      return;
    }

    // POST /api/apks/uninstall
    if (req.method === 'POST' && pathname === '/api/apks/uninstall') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const pkg = data.packageName;
          if (!pkg || !/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(pkg)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid package name' }));
            return;
          }
          const uninstRes = await execCommand('adb', ['-s', `127.0.0.1:${ADB_PORT}`, 'uninstall', pkg]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: uninstRes.code === 0, output: uninstRes.stdout }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid payload' }));
        }
      });
      return;
    }

    // POST /api/apks/upload
    if (req.method === 'POST' && pathname === '/api/apks/upload') {
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      const maxBytes = MAX_UPLOAD_MB * 1024 * 1024;
      if (contentLength > maxBytes) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `File size exceeds configured limit of ${MAX_UPLOAD_MB}MB` }));
        return;
      }

      let busboy;
      try {
        busboy = Busboy({
          headers: req.headers,
          limits: {
            files: 1,
            fileSize: maxBytes
          }
        });
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid multipart upload request' }));
        return;
      }

      let uploadFilePromise = null;

      busboy.on('file', (name, fileStream, info) => {
        const { filename } = info;
        
        // 1. Sanitize filename and verify extension
        const cleanBase = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!cleanBase.toLowerCase().endsWith('.apk')) {
          fileStream.resume(); // Discard
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Only files with .apk extension are permitted.' }));
          return;
        }

        const targetFilePath = path.join(APK_DIR, cleanBase);
        const writeStream = fs.createWriteStream(targetFilePath);
        let bytesWritten = 0;
        let headerChecked = false;
        let isZipSignature = false;
        let headerBuffer = Buffer.alloc(0);

        uploadFilePromise = new Promise((resolve, reject) => {
          fileStream.on('data', (chunk) => {
            bytesWritten += chunk.length;

            // 2. Validate ZIP/APK Magic Bytes (PK\x03\x04 or 0x50, 0x4b, 0x03, 0x04)
            if (!headerChecked) {
              headerBuffer = Buffer.concat([headerBuffer, chunk]);
              if (headerBuffer.length >= 4) {
                headerChecked = true;
                if (headerBuffer[0] === 0x50 && headerBuffer[1] === 0x4B &&
                    (headerBuffer[2] === 0x03 || headerBuffer[2] === 0x05 || headerBuffer[2] === 0x07) &&
                    (headerBuffer[3] === 0x04 || headerBuffer[3] === 0x06 || headerBuffer[3] === 0x08)) {
                  isZipSignature = true;
                } else {
                  fileStream.destroy();
                  writeStream.destroy();
                  try { fs.unlinkSync(targetFilePath); } catch (e) {}
                  reject(new Error('Uploaded file is not a valid APK/ZIP archive binary.'));
                  return;
                }
              }
            }

            writeStream.write(chunk);
          });

          fileStream.on('end', () => {
            writeStream.end();
          });

          writeStream.on('finish', () => {
            if (!isZipSignature) {
              try { fs.unlinkSync(targetFilePath); } catch (e) {}
              reject(new Error('Uploaded file failed ZIP format verification.'));
            } else {
              resolve({ targetFilePath, cleanBase, bytesWritten });
            }
          });

          fileStream.on('error', (err) => {
            try { fs.unlinkSync(targetFilePath); } catch (e) {}
            reject(err);
          });
        });
      });

      busboy.on('finish', async () => {
        if (!uploadFilePromise) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No APK file uploaded.' }));
          return;
        }

        try {
          const { targetFilePath, cleanBase } = await uploadFilePromise;

          // 3. Inspect APK using aapt if available
          let detectedPackage = '';
          const aaptRes = await execCommand('aapt', ['dump', 'badging', targetFilePath]);
          if (aaptRes.stdout) {
            const pkgMatch = aaptRes.stdout.match(/package:\s+name='([^']+)'/);
            if (pkgMatch) {
              detectedPackage = pkgMatch[1];
            }
          }

          // 4. Install into Android via adb
          const installRes = await execCommand('adb', [
            '-s', `127.0.0.1:${ADB_PORT}`,
            'install', '-r', '-d', targetFilePath
          ]);

          const isSuccess = installRes.stdout.includes('Success');

          res.writeHead(isSuccess ? 200 : 422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: isSuccess,
            filename: cleanBase,
            packageName: detectedPackage || 'unknown',
            adbOutput: installRes.stdout || installRes.stderr || 'No ADB output'
          }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      req.pipe(busboy);
      return;
    }

    // GET /api/device/logs
    if (req.method === 'GET' && pathname === '/api/device/logs') {
      let logs = [];
      const emuLogPath = path.join(LOGS_DIR, 'emulator.log');
      if (fs.existsSync(emuLogPath)) {
        try {
          const content = fs.readFileSync(emuLogPath, 'utf8');
          logs = content.split('\n').slice(-100);
        } catch (e) {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ logs }));
      return;
    }

    // Fallback 404 for unknown API
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

/**
 * Setup WebSocket Server for Remote VNC Screen Forwarding
 */
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  // Connect to local QEMU VNC server
  const tcpSocket = net.connect({ host: '127.0.0.1', port: VNC_PORT }, () => {
    // Pipe data bi-directionally
  });

  tcpSocket.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(chunk);
    }
  });

  ws.on('message', (message) => {
    if (tcpSocket.writable) {
      tcpSocket.write(message);
    }
  });

  ws.on('close', () => {
    tcpSocket.end();
  });

  ws.on('error', () => {
    tcpSocket.destroy();
  });

  tcpSocket.on('close', () => {
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, 'VNC server disconnected');
    }
  });

  tcpSocket.on('error', (err) => {
    if (ws.readyState === ws.OPEN) {
      ws.close(1011, `VNC connection error: ${err.message}`);
    }
  });
});

// Upgrade HTTP connection to WebSocket for /ws/vnc
server.on('upgrade', (req, socket, head) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  if (parsedUrl.pathname === '/ws/vnc') {
    if (!isAuthorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Start listening on 0.0.0.0:$PORT
server.listen(PORT, HOST, () => {
  console.log(`================================================================`);
  console.log(`Android Cloud Device Server listening on http://${HOST}:${PORT}`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
  console.log(`Hardware Virtualization (/dev/kvm): ${checkKvmAvailability() ? 'AVAILABLE' : 'NOT DETECTED'}`);
  console.log(`Persistent storage mount: ${DATA_DIR}`);
  console.log(`Auth required: ${Boolean(ACCESS_TOKEN)}`);
  console.log(`================================================================`);
});

// Clean shutdown signal handling
function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] Received ${signal}. Closing server cleanly...`);
  server.close(() => {
    console.log('[SHUTDOWN] HTTP/WebSocket server closed.');
    process.exit(0);
  });

  // Force exit after 5 seconds if connections linger
  setTimeout(() => {
    console.error('[SHUTDOWN] Forcing shutdown.');
    process.exit(0);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
