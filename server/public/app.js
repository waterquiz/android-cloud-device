/**
 * Android Cloud Device Web Client
 * - Live RFB (VNC) Canvas Streaming over WebSocket
 * - Touch, Mouse, and Keyboard Input Mapping
 * - Device Status & Virtualization Capability Monitoring
 * - APK Drag-and-Drop Upload, Installation & Launch Controls
 */

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const screenCanvas = document.getElementById('screenCanvas');
  const ctx = screenCanvas.getContext('2d');
  const screenOverlay = document.getElementById('screenOverlay');
  const overlayTitle = document.getElementById('overlayTitle');
  const overlayMessage = document.getElementById('overlayMessage');
  const overlaySpinner = document.getElementById('overlaySpinner');

  const tokenInput = document.getElementById('tokenInput');
  const saveTokenBtn = document.getElementById('saveTokenBtn');
  const refreshStatusBtn = document.getElementById('refreshStatusBtn');
  const restartDeviceBtn = document.getElementById('restartDeviceBtn');
  const deviceBadge = document.getElementById('deviceBadge');

  const statDeviceState = document.getElementById('statDeviceState');
  const statKvm = document.getElementById('statKvm');
  const statSoftwareEmu = document.getElementById('statSoftwareEmu');
  const statAdb = document.getElementById('statAdb');
  const statBoot = document.getElementById('statBoot');
  const statDisk = document.getElementById('statDisk');
  const statOsImage = document.getElementById('statOsImage');

  const toggleOverlayBtn = document.getElementById('toggleOverlayBtn');
  const overlayDismissBtn = document.getElementById('overlayDismissBtn');
  const imageDownloadUrl = document.getElementById('imageDownloadUrl');
  const btnDownloadImage = document.getElementById('btnDownloadImage');
  const imageDownloadStatus = document.getElementById('imageDownloadStatus');

  const diagnosticAlert = document.getElementById('diagnosticAlert');
  const alertHeading = document.getElementById('alertHeading');
  const alertBody = document.getElementById('alertBody');

  const dropZone = document.getElementById('dropZone');
  const apkFileInput = document.getElementById('apkFileInput');
  const selectApkBtn = document.getElementById('selectApkBtn');
  const uploadStatusBox = document.getElementById('uploadStatusBox');
  const uploadProgressBar = document.getElementById('uploadProgressBar');
  const uploadStatusText = document.getElementById('uploadStatusText');

  const appsList = document.getElementById('appsList');
  const refreshAppsBtn = document.getElementById('refreshAppsBtn');
  const logConsole = document.getElementById('logConsole');
  const toggleLogsBtn = document.getElementById('toggleLogsBtn');

  const btnBack = document.getElementById('btnBack');
  const btnHome = document.getElementById('btnHome');
  const btnRecents = document.getElementById('btnRecents');
  const btnVolDown = document.getElementById('btnVolDown');
  const btnVolUp = document.getElementById('btnVolUp');
  const btnPower = document.getElementById('btnPower');
  const typeTextInput = document.getElementById('typeTextInput');
  const btnSendText = document.getElementById('btnSendText');

  // State
  let authToken = localStorage.getItem('android_cloud_token') || 'Fraz1234';
  tokenInput.value = authToken;
  let ws = null;
  let isWsConnected = false;
  let rfbHandshakeStep = 0;
  let fbWidth = 720;
  let fbHeight = 1280;
  let rfbBuffer = new Uint8Array(0);
  let userDismissedOverlay = false;
  let lastSeenState = null;

  // Authentication Token Management
  saveTokenBtn.addEventListener('click', () => {
    authToken = tokenInput.value.trim();
    localStorage.setItem('android_cloud_token', authToken);
    showToast('Token saved.');
    fetchStatus();
    connectVnc();
  });

  function getHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
      headers['x-access-token'] = authToken;
    }
    return headers;
  }

  // Fetch Device Status
  async function fetchStatus() {
    try {
      const res = await fetch('/api/device/status', { headers: getHeaders() });
      if (res.status === 401) {
        setDeviceBadge('AUTH REQUIRED', 'status-error');
        setOverlay('Authentication Required', 'Please provide a valid ACCESS_TOKEN in the top right.', false);
        return;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      statDeviceState.textContent = data.state;
      statKvm.textContent = data.kvm_available ? 'Available (/dev/kvm detected)' : 'Unavailable (No /dev/kvm)';
      statSoftwareEmu.textContent = data.allow_software_emulation ? 'Enabled (TCG fallback)' : 'Disabled';
      statAdb.textContent = data.adb_connected ? 'Connected (127.0.0.1:5555)' : 'Disconnected';
      statBoot.textContent = data.boot_completed ? 'Yes (sys.boot_completed=1)' : 'No';
      statDisk.textContent = `${data.disk_usage.freeMb} MB free / ${data.disk_usage.totalMb} MB total`;

      if (data.os_image && statOsImage) {
        if (data.os_image.found) {
          statOsImage.textContent = `${data.os_image.name} (${data.os_image.sizeMb} MB, ${data.os_image.type})`;
          statOsImage.style.color = 'var(--status-running, #22c55e)';
        } else {
          statOsImage.textContent = 'None detected (requires ISO/image)';
          statOsImage.style.color = 'var(--status-error, #ef4444)';
        }
      }

      // Automatically connect VNC whenever QEMU is running (booting, running, or boot timeout)
      const canConnectVnc = ['RUNNING', 'BOOTING', 'BOOT_TIMEOUT'].includes(data.state);
      if (canConnectVnc && !isWsConnected) {
        connectVnc();
      }

      // Reset overlay dismissal if state changed (unless transitioning to RUNNING)
      if (lastSeenState !== data.state) {
        lastSeenState = data.state;
        if (data.state === 'RUNNING') {
          userDismissedOverlay = true;
        }
      }

      // Update badge and overlay based on state
      if (data.state === 'RUNNING') {
        setDeviceBadge('RUNNING', 'status-running');
        hideOverlay();
      } else if (data.state === 'BOOTING') {
        setDeviceBadge('BOOTING', 'status-booting');
        hideOverlay();
      } else if (data.state === 'MISSING_IMAGE') {
        setDeviceBadge('MISSING IMAGE', 'status-error');
        setOverlay('No Bootable Android Image Found', 'The virtual hard drive is empty. Provide an Android-x86 ISO URL under "Android OS Image Setup" or set ANDROID_IMAGE_URL in Railway.', false);
      } else if (data.state === 'BOOT_TIMEOUT') {
        setDeviceBadge('BOOT TIMEOUT', 'status-warning');
        setOverlay('Boot Timeout', 'Android is taking longer than expected. Click "View Screen Output" to inspect the console or GRUB menu.', false);
      } else if (data.state === 'CRASHED') {
        setDeviceBadge('CRASHED', 'status-error');
        setOverlay('Emulator Failed', data.diagnostic || 'QEMU process exited unexpectedly. Check logs below.', false);
      } else if (data.state === 'MISSING_KVM') {
        setDeviceBadge('MISSING KVM', 'status-error');
        setOverlay('Hardware Virtualization Missing', 'Railway standard containers do not expose /dev/kvm. See Diagnostic Notice.', false);
      } else {
        setDeviceBadge(data.state, 'status-stopped');
      }

      // Railway / Virtualization Diagnostic Alert
      if (!data.kvm_available) {
        diagnosticAlert.classList.remove('hidden');
        alertHeading.textContent = 'Railway Environment: Hardware Virtualization (/dev/kvm) Unavailable';
        if (data.allow_software_emulation) {
          alertBody.textContent = 'Hardware acceleration is absent. The container is running in TCG software emulation mode (ALLOW_SOFTWARE_EMULATION=true). Performance will be slow and CPU usage elevated.';
        } else {
          alertBody.textContent = 'Railway container instances run without /dev/kvm privileges. To prevent CPU exhaustion, the Android VM will not boot automatically. Set ALLOW_SOFTWARE_EMULATION=true in Railway Environment Variables to attempt software emulation, or deploy to a container runtime with /dev/kvm enabled.';
        }
      } else {
        diagnosticAlert.classList.add('hidden');
      }

      fetchLogs();
    } catch (err) {
      setDeviceBadge('SERVER UNREACHABLE', 'status-error');
      setOverlay('Connection Error', 'Cannot reach management server. Retrying...', true);
    }
  }

  function setDeviceBadge(text, cls) {
    deviceBadge.textContent = text;
    deviceBadge.className = `status-badge ${cls}`;
  }

  function setOverlay(title, message, showSpinner) {
    overlayTitle.textContent = title;
    overlayMessage.textContent = message;
    overlaySpinner.style.display = showSpinner ? 'block' : 'none';
    if (!userDismissedOverlay) {
      screenOverlay.classList.remove('hidden');
    }
  }

  function hideOverlay() {
    screenOverlay.classList.add('hidden');
  }

  function toggleOverlay() {
    if (screenOverlay.classList.contains('hidden')) {
      screenOverlay.classList.remove('hidden');
      userDismissedOverlay = false;
    } else {
      screenOverlay.classList.add('hidden');
      userDismissedOverlay = true;
    }
  }

  if (toggleOverlayBtn) toggleOverlayBtn.addEventListener('click', toggleOverlay);
  if (overlayDismissBtn) overlayDismissBtn.addEventListener('click', () => {
    screenOverlay.classList.add('hidden');
    userDismissedOverlay = true;
  });

  // ============================================================================
  // WebSocket VNC Client Implementation
  // ============================================================================
  function connectVnc() {
    if (ws) {
      try { ws.close(); } catch (e) {}
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl = `${protocol}//${window.location.host}/ws/vnc`;
    if (authToken) {
      wsUrl += `?token=${encodeURIComponent(authToken)}`;
    }

    rfbHandshakeStep = 0;
    rfbBuffer = new Uint8Array(0);

    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      isWsConnected = true;
    };

    ws.onmessage = (event) => {
      const data = new Uint8Array(event.data);
      appendRfbBuffer(data);
      processRfbPackets();
    };

    let keepAliveTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && rfbHandshakeStep === 4) {
        requestFramebufferUpdate(0, 0, fbWidth, fbHeight, 1);
      }
    }, 15000);

    ws.onclose = () => {
      clearInterval(keepAliveTimer);
      isWsConnected = false;
      setTimeout(() => {
        if (!isWsConnected) connectVnc();
      }, 2000);
    };

    ws.onerror = () => {
      isWsConnected = false;
    };
  }

  function appendRfbBuffer(chunk) {
    const combined = new Uint8Array(rfbBuffer.length + chunk.length);
    combined.set(rfbBuffer, 0);
    combined.set(chunk, rfbBuffer.length);
    rfbBuffer = combined;
  }

  function processRfbPackets() {
    // Step 0: ProtocolVersion handshake (expect RFB 003.00x\n)
    if (rfbHandshakeStep === 0) {
      if (rfbBuffer.length < 12) return;
      // Send client version
      const clientVer = new TextEncoder().encode('RFB 003.008\n');
      ws.send(clientVer);
      rfbBuffer = rfbBuffer.slice(12);
      rfbHandshakeStep = 1;
      return;
    }

    // Step 1: Security Handshake
    if (rfbHandshakeStep === 1) {
      if (rfbBuffer.length < 1) return;
      const numTypes = rfbBuffer[0];
      if (rfbBuffer.length < 1 + numTypes) return;

      // Select None security (type 1)
      ws.send(new Uint8Array([1]));
      rfbBuffer = rfbBuffer.slice(1 + numTypes);
      rfbHandshakeStep = 2;
      return;
    }

    // Step 2: SecurityResult
    if (rfbHandshakeStep === 2) {
      if (rfbBuffer.length < 4) return;
      // 0 = OK
      rfbBuffer = rfbBuffer.slice(4);
      // Send ClientInit (shared-flag = 1)
      ws.send(new Uint8Array([1]));
      rfbHandshakeStep = 3;
      return;
    }

    // Step 3: ServerInit
    if (rfbHandshakeStep === 3) {
      if (rfbBuffer.length < 24) return;
      const dv = new DataView(rfbBuffer.buffer, rfbBuffer.byteOffset);
      fbWidth = dv.getUint16(0);
      fbHeight = dv.getUint16(2);
      const nameLength = dv.getUint32(20);

      if (rfbBuffer.length < 24 + nameLength) return;

      screenCanvas.width = fbWidth;
      screenCanvas.height = fbHeight;
      rfbBuffer = rfbBuffer.slice(24 + nameLength);
      rfbHandshakeStep = 4; // Ready for normal framebuffer updates

      userDismissedOverlay = true;
      hideOverlay();

      // Request full initial update
      requestFramebufferUpdate(0, 0, fbWidth, fbHeight, 0);
      return;
    }

    // Step 4: Handle FramebufferUpdate messages
    if (rfbHandshakeStep === 4) {
      while (rfbBuffer.length > 0) {
        const msgType = rfbBuffer[0];
        if (msgType === 0) {
          // FramebufferUpdate
          if (rfbBuffer.length < 4) return;
          const dv = new DataView(rfbBuffer.buffer, rfbBuffer.byteOffset);
          const numRects = dv.getUint16(2);

          let offset = 4;
          let rectsParsed = 0;

          for (let i = 0; i < numRects; i++) {
            if (rfbBuffer.length < offset + 12) return; // Wait for rect header
            const rDv = new DataView(rfbBuffer.buffer, rfbBuffer.byteOffset + offset);
            const rx = rDv.getUint16(0);
            const ry = rDv.getUint16(2);
            const rw = rDv.getUint16(4);
            const rh = rDv.getUint16(6);
            const encoding = rDv.getInt32(8);

            const pixelBytes = rw * rh * 4; // 32bpp raw
            if (encoding === 0) { // Raw encoding
              if (rfbBuffer.length < offset + 12 + pixelBytes) return; // Wait for pixels

              const pixels = rfbBuffer.subarray(offset + 12, offset + 12 + pixelBytes);
              const imgData = ctx.createImageData(rw, rh);
              const dest = imgData.data;

              // Convert BGRX to RGBA
              for (let p = 0, d = 0; p < pixelBytes; p += 4, d += 4) {
                dest[d]     = pixels[p + 2]; // R
                dest[d + 1] = pixels[p + 1]; // G
                dest[d + 2] = pixels[p];     // B
                dest[d + 3] = 255;           // A
              }

              ctx.putImageData(imgData, rx, ry);
              offset += 12 + pixelBytes;
              rectsParsed++;
            } else {
              // Non-raw encodings skipped for simplicity
              offset += 12;
              rectsParsed++;
            }
          }

          rfbBuffer = rfbBuffer.slice(offset);
          // Request next incremental update
          requestFramebufferUpdate(0, 0, fbWidth, fbHeight, 1);
        } else {
          // Skip other server message types (Bell, CutText, etc.)
          rfbBuffer = rfbBuffer.slice(1);
        }
      }
    }
  }

  function requestFramebufferUpdate(x, y, w, h, incremental) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const req = new Uint8Array(10);
    req[0] = 3; // FramebufferUpdateRequest
    req[1] = incremental;
    const dv = new DataView(req.buffer);
    dv.setUint16(2, x);
    dv.setUint16(4, y);
    dv.setUint16(6, w);
    dv.setUint16(8, h);
    ws.send(req);
  }

  // Pointer & Touch Events
  function sendPointerEvent(buttonMask, x, y) {
    if (!ws || ws.readyState !== WebSocket.OPEN || rfbHandshakeStep < 4) return;
    const packet = new Uint8Array(6);
    packet[0] = 5; // PointerEvent
    packet[1] = buttonMask;
    const dv = new DataView(packet.buffer);
    dv.setUint16(2, Math.max(0, Math.min(fbWidth - 1, Math.round(x))));
    dv.setUint16(4, Math.max(0, Math.min(fbHeight - 1, Math.round(y))));
    ws.send(packet);
  }

  function getCanvasCoords(evt) {
    const rect = screenCanvas.getBoundingClientRect();
    const scaleX = fbWidth / rect.width;
    const scaleY = fbHeight / rect.height;
    const clientX = evt.clientX || (evt.touches && evt.touches[0] ? evt.touches[0].clientX : 0);
    const clientY = evt.clientY || (evt.touches && evt.touches[0] ? evt.touches[0].clientY : 0);
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  }

  let isMouseDown = false;

  screenCanvas.addEventListener('mousedown', (e) => {
    isMouseDown = true;
    const c = getCanvasCoords(e);
    sendPointerEvent(1, c.x, c.y);
  });

  window.addEventListener('mousemove', (e) => {
    if (!isMouseDown) return;
    const c = getCanvasCoords(e);
    sendPointerEvent(1, c.x, c.y);
  });

  window.addEventListener('mouseup', (e) => {
    if (!isMouseDown) return;
    isMouseDown = false;
    const c = getCanvasCoords(e);
    sendPointerEvent(0, c.x, c.y);
  });

  // Touch handlers
  screenCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const c = getCanvasCoords(e);
    sendPointerEvent(1, c.x, c.y);
  }, { passive: false });

  screenCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const c = getCanvasCoords(e);
    sendPointerEvent(1, c.x, c.y);
  }, { passive: false });

  screenCanvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    const c = getCanvasCoords(e);
    sendPointerEvent(0, c.x, c.y);
  }, { passive: false });

  // ============================================================================
  // VNC Keyboard Input Forwarding
  // ============================================================================
  function sendKeyEvent(down, keysym) {
    if (!ws || ws.readyState !== WebSocket.OPEN || rfbHandshakeStep !== 4) return;
    const buf = new Uint8Array(8);
    buf[0] = 4; // KeyEvent
    buf[1] = down ? 1 : 0;
    buf[2] = 0;
    buf[3] = 0;
    buf[4] = (keysym >> 24) & 0xFF;
    buf[5] = (keysym >> 16) & 0xFF;
    buf[6] = (keysym >> 8) & 0xFF;
    buf[7] = keysym & 0xFF;
    ws.send(buf);
  }

  function mapKeyToKeysym(key) {
    if (key === 'Enter') return 0xFF0D;
    if (key === 'Escape') return 0xFF1B;
    if (key === 'Backspace') return 0xFF08;
    if (key === 'Tab') return 0xFF09;
    if (key === 'ArrowUp') return 0xFF52;
    if (key === 'ArrowDown') return 0xFF54;
    if (key === 'ArrowLeft') return 0xFF51;
    if (key === 'ArrowRight') return 0xFF53;
    if (key === 'Home') return 0xFF50;
    if (key === 'End') return 0xFF57;
    if (key === 'PageUp') return 0xFF55;
    if (key === 'PageDown') return 0xFF56;
    if (key.length === 1) return key.charCodeAt(0);
    return null;
  }

  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    const keysym = mapKeyToKeysym(e.key);
    if (keysym !== null) {
      sendKeyEvent(true, keysym);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    const keysym = mapKeyToKeysym(e.key);
    if (keysym !== null) {
      sendKeyEvent(false, keysym);
    }
  });

  // ============================================================================
  // Hardware Keys & ADB Actions
  // ============================================================================
  async function sendKey(key) {
    try {
      await fetch('/api/device/input/key', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ key })
      });
    } catch (e) {
      console.error('Failed to send key:', e);
    }
  }

  btnBack.addEventListener('click', () => sendKey('BACK'));
  btnHome.addEventListener('click', () => sendKey('HOME'));
  btnRecents.addEventListener('click', () => sendKey('APP_SWITCH'));
  btnVolDown.addEventListener('click', () => sendKey('VOLUME_DOWN'));
  btnVolUp.addEventListener('click', () => sendKey('VOLUME_UP'));
  btnPower.addEventListener('click', () => sendKey('POWER'));

  btnSendText.addEventListener('click', async () => {
    const text = typeTextInput.value;
    if (!text) return;
    try {
      await fetch('/api/device/input/text', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ text })
      });
      typeTextInput.value = '';
    } catch (e) {
      alert('Failed to send text');
    }
  });

  // ============================================================================
  // APK Upload & Installation
  // ============================================================================
  selectApkBtn.addEventListener('click', () => apkFileInput.click());
  apkFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleApkUpload(e.target.files[0]);
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleApkUpload(e.dataTransfer.files[0]);
    }
  });

  function handleApkUpload(file) {
    if (!file.name.toLowerCase().endsWith('.apk')) {
      alert('Only .apk files can be installed.');
      return;
    }

    uploadStatusBox.classList.remove('hidden');
    uploadProgressBar.style.width = '0%';
    uploadStatusText.textContent = `Uploading ${file.name}...`;

    const formData = new FormData();
    formData.append('apk', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/apks/upload', true);

    if (authToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
      xhr.setRequestHeader('x-access-token', authToken);
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        uploadProgressBar.style.width = `${percent}%`;
        uploadStatusText.textContent = `Uploading ${percent}%... (${Math.round(e.loaded / (1024 * 1024))}MB)`;
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        const resp = JSON.parse(xhr.responseText);
        uploadStatusText.textContent = `✅ Successfully installed ${resp.packageName || resp.filename}!`;
        uploadProgressBar.style.backgroundColor = 'var(--color-success)';
        fetchInstalledApps();
      } else {
        let err = 'Installation failed';
        try {
          const resp = JSON.parse(xhr.responseText);
          err = resp.error || resp.adbOutput || err;
        } catch (e) {}
        uploadStatusText.textContent = `❌ ${err}`;
        uploadProgressBar.style.backgroundColor = 'var(--color-danger)';
      }
    };

    xhr.onerror = () => {
      uploadStatusText.textContent = '❌ Upload network error.';
      uploadProgressBar.style.backgroundColor = 'var(--color-danger)';
    };

    xhr.send(formData);
  }

  // ============================================================================
  // Installed Applications Management
  // ============================================================================
  async function fetchInstalledApps() {
    try {
      const res = await fetch('/api/apks/installed', { headers: getHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      renderApps(data.packages || []);
    } catch (e) {
      console.error('Failed to fetch apps:', e);
    }
  }

  function renderApps(packages) {
    appsList.innerHTML = '';
    if (packages.length === 0) {
      appsList.innerHTML = '<div class="empty-state">No third-party applications installed.</div>';
      return;
    }

    packages.forEach((pkg) => {
      const item = document.createElement('div');
      item.className = 'app-item';

      const info = document.createElement('div');
      info.className = 'app-info';

      const name = document.createElement('span');
      name.className = 'app-name';
      name.textContent = pkg.packageName.split('.').pop() || pkg.packageName;

      const pkgId = document.createElement('span');
      pkgId.className = 'app-package';
      pkgId.textContent = pkg.packageName;

      info.appendChild(name);
      info.appendChild(pkgId);

      const actions = document.createElement('div');
      actions.className = 'app-actions';

      const launchBtn = document.createElement('button');
      launchBtn.className = 'btn btn-primary btn-xs';
      launchBtn.textContent = 'Launch';
      launchBtn.onclick = () => launchApp(pkg.packageName);

      const uninstallBtn = document.createElement('button');
      uninstallBtn.className = 'btn btn-danger btn-xs';
      uninstallBtn.textContent = 'Uninstall';
      uninstallBtn.onclick = () => uninstallApp(pkg.packageName);

      actions.appendChild(launchBtn);
      actions.appendChild(uninstallBtn);

      item.appendChild(info);
      item.appendChild(actions);

      appsList.appendChild(item);
    });
  }

  async function launchApp(packageName) {
    try {
      const res = await fetch('/api/apks/launch', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ packageName })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Launched ${packageName}`);
      } else {
        alert(`Launch failed: ${data.error}`);
      }
    } catch (e) {
      alert('Failed to launch application');
    }
  }

  async function uninstallApp(packageName) {
    if (!confirm(`Are you sure you want to uninstall ${packageName}?`)) return;
    try {
      const res = await fetch('/api/apks/uninstall', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ packageName })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Uninstalled ${packageName}`);
        fetchInstalledApps();
      } else {
        alert(`Uninstall failed: ${data.error || data.output}`);
      }
    } catch (e) {
      alert('Failed to uninstall application');
    }
  }

  refreshAppsBtn.addEventListener('click', fetchInstalledApps);

  // Restart Device
  restartDeviceBtn.addEventListener('click', async () => {
    if (!confirm('Restart Android device?')) return;
    try {
      await fetch('/api/device/restart', { method: 'POST', headers: getHeaders() });
      showToast('Restart initiated.');
      fetchStatus();
    } catch (e) {
      alert('Failed to restart device');
    }
  });

  refreshStatusBtn.addEventListener('click', () => {
    fetchStatus();
    fetchInstalledApps();
  });

  // OS Image Download Handler
  if (btnDownloadImage && imageDownloadUrl) {
    btnDownloadImage.addEventListener('click', async () => {
      const url = imageDownloadUrl.value.trim();
      if (!url) {
        if (imageDownloadStatus) {
          imageDownloadStatus.textContent = 'Please enter a direct image URL.';
          imageDownloadStatus.style.color = '#ef4444';
        }
        return;
      }

      btnDownloadImage.disabled = true;
      if (imageDownloadStatus) {
        imageDownloadStatus.textContent = 'Requesting download...';
        imageDownloadStatus.style.color = '#38bdf8';
      }

      try {
        const res = await fetch('/api/image/download', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ url })
        });
        const resp = await res.json();
        if (!res.ok) throw new Error(resp.error || 'Download failed');
        if (imageDownloadStatus) {
          imageDownloadStatus.textContent = resp.message || 'Download started! Watch System Logs for progress.';
          imageDownloadStatus.style.color = '#22c55e';
        }
        showToast('Image download started');
        fetchStatus();
      } catch (err) {
        if (imageDownloadStatus) {
          imageDownloadStatus.textContent = `Error: ${err.message}`;
          imageDownloadStatus.style.color = '#ef4444';
        }
      } finally {
        btnDownloadImage.disabled = false;
      }
    });
  }

  // Logs
  let logsVisible = true;
  toggleLogsBtn.addEventListener('click', () => {
    logsVisible = !logsVisible;
    logConsole.style.display = logsVisible ? 'block' : 'none';
  });

  async function fetchLogs() {
    try {
      const res = await fetch('/api/device/logs', { headers: getHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      if (data.logs && data.logs.length > 0) {
        logConsole.textContent = data.logs.join('\n');
        logConsole.scrollTop = logConsole.scrollHeight;
      }
    } catch (e) {}
  }

  function showToast(msg) {
    console.log('[NOTIFICATION]', msg);
  }

  // Periodic polling
  connectVnc();
  fetchStatus();
  fetchInstalledApps();
  setInterval(fetchStatus, 4000);
  setInterval(fetchInstalledApps, 8000);
});
