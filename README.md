# Android Cloud Device on Railway

A complete, self-contained **single Android Cloud Device** designed to run on **Railway** using Docker. It enables remote APK installation, application execution, and real-time interactive browser-based screen viewing with touch, mouse, and keyboard control.

---

## 1. What the Project Does

- **Single Remote Android Device:** Runs an isolated, single-instance Android OS in a Docker container.
- **In-Browser Remote Control:** Delivers interactive visual screen streaming over WebSockets (RFB/VNC protocol) directly in any modern desktop or mobile browser.
- **Hardware & Touch Input:** Supports touch gestures, mouse clicks/drags, keyboard typing, and physical Android navigation keys (Back, Home, Recent Apps, Volume, Power).
- **Safe APK Upload & Installation:** Upload `.apk` packages via the web interface or REST API, inspect metadata, and install them into the device using ADB.
- **App Launcher:** One-click launcher to start installed third-party applications on the cloud device.
- **Persistent Storage:** Retains installed apps, configurations, and user data across container restarts using Railway Volumes mounted at `/data`.
- **Clean Environment:** No Google Play Store, no Gmail, no Google accounts, and no background Google Play Services.
- **Deployment-Ready:** Listens dynamically on `0.0.0.0:$PORT` with a `/health` endpoint compliant with Railway's container platform.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Web Browser Client                              │
│  - Live Screen Canvas (WebSocket RFB / Touch / Mouse / Keyboard)            │
│  - Android Virtual Buttons (Back, Home, Recents, Vol+, Vol-, Power)        │
│  - APK Drag-and-Drop & Management Dashboard                                 │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ HTTP / WebSocket ($PORT)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Railway Container (Docker Runtime)                     │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    Node.js Management Server                          │  │
│  │  - Health Check Endpoint (/health) -> HTTP 200                         │  │
│  │  - Token Authentication (ACCESS_TOKEN)                                │  │
│  │  - APK Validation (ZIP magic bytes, path sanitization, size limit)    │  │
│  │  - WebSocket VNC Proxy (Browser <-> 127.0.0.1:5900)                   │  │
│  │  - REST API for ADB Actions (Install, Launch, Uninstall, Keyevents)   │  │
│  └──────────────────┬─────────────────────────────┬──────────────────────┘  │
│                     │ Local TCP (5900)            │ Local TCP (5555)        │
│                     ▼                             ▼                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     Android OS Runtime (QEMU)                         │  │
│  │  - KVM Acceleration (if /dev/kvm is available)                       │  │
│  │  - TCG Software Emulation fallback (if ALLOW_SOFTWARE_EMULATION=true) │  │
│  │  - VNC Framebuffer (127.0.0.1:5900)                                   │  │
│  │  - Internal ADB Daemon (127.0.0.1:5555)                               │  │
│  │  - Virtual USB Tablet for Absolute Pointer Mapping                    │  │
│  └──────────────────────────────────┬────────────────────────────────────┘  │
│                                     │                                       │
│                                     ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                   Persistent Railway Volume (/data)                   │  │
│  │  - /data/android/ (Virtual disk images: system.qcow2, data.qcow2)     │  │
│  │  - /data/apks/    (Stored APK binaries)                               │  │
│  │  - /data/logs/    (Emulator & execution logs)                         │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Local Testing Instructions

You can build and test the container locally on Linux, macOS, or Windows (with WSL2).

### Prerequisites
- Docker installed and running.
- Hardware virtualization (`/dev/kvm`) enabled in your BIOS/UEFI (optional, but recommended for speed).

### Build the Docker Image
```bash
docker build -t android-cloud-device .
```

### Run Locally with Hardware Acceleration (Linux / WSL2)
```bash
docker run -d \
  --name android-device \
  --device /dev/kvm \
  -p 8080:8080 \
  -e PORT=8080 \
  -e ACCESS_TOKEN=my-secret-token \
  -v "$(pwd)/data:/data" \
  android-cloud-device
```

### Run Locally in Software Emulation Mode (Without KVM)
```bash
docker run -d \
  --name android-device \
  -p 8080:8080 \
  -e PORT=8080 \
  -e ALLOW_SOFTWARE_EMULATION=true \
  -e ACCESS_TOKEN=my-secret-token \
  -v "$(pwd)/data:/data" \
  android-cloud-device
```

Open your browser at `http://localhost:8080`.

---

## 4. GitHub Setup

To prepare this repository for Railway:

1. Initialize git and commit:
   ```bash
   git init
   git add .
   git commit -m "feat: initial Android cloud device for Railway"
   git branch -M main
   ```
2. Create a new GitHub repository named `android-cloud-device`.
3. Add your remote and push:
   ```bash
   git remote add origin https://github.com/<your-username>/android-cloud-device.git
   git push -u origin main
   ```

---

## 5. Railway Deployment Instructions

1. Log in to [Railway](https://railway.app/).
2. Click **New Project** -> **Deploy from GitHub repo**.
3. Select your repository: `android-cloud-device`.
4. Railway will automatically detect the `Dockerfile` and initiate the container build.
5. Once deployed, configure the **Persistent Volume** and **Environment Variables** (see below).
6. Under the service settings, click **Generate Domain** under Networking to assign a public Railway HTTPS domain.

---

## 6. Required Railway Settings

| Setting | Value | Notes |
| :--- | :--- | :--- |
| **Build Type** | Dockerfile | Detected automatically from repo root. |
| **Healthcheck Path** | `/health` | Returns HTTP 200 when management server is active. |
| **Port** | Assigned dynamically | Railway automatically supplies the `PORT` env variable. The server listens on `0.0.0.0:$PORT`. |
| **Restart Policy** | Always / On failure | Recommended to maintain 24/7 device availability. |

---

## 7. Persistent Volume Setup

To ensure installed APKs and Android app data persist across deployments and container restarts:

1. Open your project dashboard in Railway.
2. Go to your `android-cloud-device` service.
3. Click the **Volumes** tab.
4. Click **Add Volume**.
5. Set the Mount Path exactly to:
   ```text
   /data
   ```
6. Set the initial size (e.g., 10 GB or more depending on your app needs).

---

## 8. Environment Variables

Configure these under the **Variables** tab in your Railway service:

| Variable | Default | Required | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | `8080` | Automatic | Injected automatically by Railway. Binds web server to `0.0.0.0:$PORT`. |
| `ACCESS_TOKEN` | `Fraz1234` | Recommended | Secret token required to authenticate to the dashboard and API. |
| `ALLOW_SOFTWARE_EMULATION` | `true` | Optional | Set to `true` to run Android without hardware virtualization (`/dev/kvm`). |
| `ANDROID_IMAGE_URL` | *Empty* | Recommended | Direct URL to download an Android-x86 ISO/image (e.g. Android 7.1 or 9.0) into `/data/android/`. |
| `BOOT_TIMEOUT_SECONDS` | `600` | Optional | Maximum seconds to wait for Android boot completion before showing status timeout. |
| `MAX_UPLOAD_MB` | `250` | Optional | Maximum allowed APK upload size in megabytes. |
| `RAM_SIZE` | `2048` | Optional | Device RAM allocation in megabytes (e.g. `2048`). |
| `CPU_CORES` | `2` | Optional | Number of virtual CPU cores allocated to Android. |

---

## 9. APK Installation Instructions

### Method A: Web Interface
1. Navigate to your Railway service domain: `https://<your-service>.up.railway.app`.
2. If `ACCESS_TOKEN` is configured, enter your token in the top-right field and click **Save Token**.
3. In the **Install Application (APK)** card, drag and drop your `.apk` file or click **Select APK File**.
4. The system validates the APK structure, checks file magic bytes, transfers the binary to `/data/apks/`, and invokes `adb install`.
5. Once finished, the package appears under **Installed Applications**.
6. Click **Launch** to start the app on the screen.

### Method B: REST API (cURL)
```bash
curl -X POST "https://<your-service>.up.railway.app/api/apks/upload" \
  -H "Authorization: Bearer <your-access-token>" \
  -F "apk=@/path/to/my-app.apk"
```

### Launch an Installed Package via API
```bash
curl -X POST "https://<your-service>.up.railway.app/api/apks/launch" \
  -H "Authorization: Bearer <your-access-token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName": "com.example.myapp"}'
```

---

## 10. How to Access the Device via Railway

1. Open your generated Railway domain: `https://<your-service>.up.railway.app`.
2. The browser initiates a secure WebSocket connection (`wss://.../ws/vnc`) to the internal RFB display buffer.
3. Click or touch directly on the screen canvas to send inputs.
4. Use the bottom navigation bar for **Back**, **Home**, **Recents**, **Volume**, and **Power**.
5. Send typed strings into text fields using the **Quick Text** bar.

---

## 11. Known Railway Limitations

### Hardware Virtualization (`/dev/kvm`)
- **Limitation:** Standard Railway cloud container instances execute inside multi-tenant Linux containers without exposed hardware virtualization (`/dev/kvm`) or custom kernel modules (`binder_linux`/`ashmem_linux`).
- **Impact on Android:** An Android emulator natively relies on KVM for hardware acceleration.
- **Handling in this repository:**
  - `start.sh` automatically probes `/dev/kvm` and CPU virtualization flags.
  - If `/dev/kvm` is missing and `ALLOW_SOFTWARE_EMULATION=false` (default safe mode), the system outputs a clear diagnostic in the console and web dashboard without crashing the container or failing `/health`.
  - If `ALLOW_SOFTWARE_EMULATION=true` is enabled, QEMU will execute via TCG (Tiny Code Generator) software emulation. **Software emulation is CPU-intensive and requires substantial boot time.**
  - For full native speed, deploy the container to a host or cloud VM with nested virtualization (`/dev/kvm`) enabled.

---

## 12. Troubleshooting

### Container Crashes on Start
- Verify that the persistent volume is mounted at `/data`.
- Check Railway logs: verify that Node.js started on `0.0.0.0:$PORT`.
- Confirm `/health` returns HTTP 200.

### APK Installation Fails
- Ensure the file is a valid Android APK compiled for `x86_64` or universal architecture (ARM APKs require an ARM translation library).
- Verify the APK size is within `MAX_UPLOAD_MB`.
- Check `adb` output in the web console.

### Screen Shows "No Bootable Device" or Infinite "Android Booting"
- **Cause:** No bootable Android OS image exists in `/data/android/`. An empty virtual disk has no operating system.
- **Fix:**
  1. Click **Toggle Screen** on the dashboard to view the actual QEMU console.
  2. Provide a bootable image URL using the **Android OS Image Setup** card on the web dashboard or set `ANDROID_IMAGE_URL` in Railway Variables (e.g., an Android-x86 7.1 or 9.0 ISO).
  3. Once downloaded, restart the container to boot into Android.

### VNC Screen Shows "Display Disconnected"
- Check the **System Diagnostics** panel. If the state is `BOOTING`, the Android OS is still loading its graphical user interface.
- If state is `MISSING_KVM`, set `ALLOW_SOFTWARE_EMULATION=true` in environment variables or run on a KVM-enabled runner.

---

## 13. Security Warnings

- **Never expose raw ADB ports to the public internet.** In this design, ADB (`5555`) and VNC (`5900`) bind strictly to `127.0.0.1` inside the container.
- **Always set `ACCESS_TOKEN`.** Without `ACCESS_TOKEN`, anyone with your Railway public domain can upload APKs and interact with your device.
- **Do not commit `.env` files or credentials to Git.** All secrets must be passed via Railway Environment Variables.
- **APK validation:** Uploaded APKs are validated for file extension and ZIP archive magic headers (`PK\x03\x04`). Files are never executed directly on the host Linux OS.
