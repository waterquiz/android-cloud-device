#!/usr/bin/env bash
# ==============================================================================
# Android Cloud Device - Startup & Supervisor Script
# ==============================================================================
set -e

echo "================================================================================"
echo "          Starting Android Cloud Device on Railway"
echo "================================================================================"

# Preserve incoming environment variables
_ENV_ACCESS_TOKEN="$ACCESS_TOKEN"
_ENV_ALLOW_SOFTWARE_EMULATION="$ALLOW_SOFTWARE_EMULATION"
_ENV_RAM_SIZE="$RAM_SIZE"
_ENV_CPU_CORES="$CPU_CORES"
_ENV_DISK_SIZE="$DISK_SIZE"
_ENV_ADB_PORT="$ADB_PORT"
_ENV_VNC_PORT="$VNC_PORT"
_ENV_DATA_DIR="$DATA_DIR"
_ENV_PORT="$PORT"

# Load configuration file if present
CONF_FILE="/app/config/device.conf"
if [ -f "$CONF_FILE" ]; then
    echo "[CONFIG] Loading settings from $CONF_FILE"
    # shellcheck disable=SC1090
    source "$CONF_FILE"
fi

# Apply environment variable overrides (environment variables take top precedence)
ACCESS_TOKEN="${_ENV_ACCESS_TOKEN:-${ACCESS_TOKEN:-Fraz1234}}"
ALLOW_SOFTWARE_EMULATION="${_ENV_ALLOW_SOFTWARE_EMULATION:-${ALLOW_SOFTWARE_EMULATION:-true}}"
RAM_SIZE="${_ENV_RAM_SIZE:-${RAM_SIZE:-2048}}"
CPU_CORES="${_ENV_CPU_CORES:-${CPU_CORES:-2}}"
DISK_SIZE="${_ENV_DISK_SIZE:-${DISK_SIZE:-8G}}"
ADB_PORT="${_ENV_ADB_PORT:-${ADB_PORT:-5555}}"
VNC_PORT="${_ENV_VNC_PORT:-${VNC_PORT:-5900}}"
DATA_DIR="${_ENV_DATA_DIR:-${DATA_DIR:-/data}}"
PORT="${_ENV_PORT:-${PORT:-8080}}"

export ACCESS_TOKEN ALLOW_SOFTWARE_EMULATION RAM_SIZE CPU_CORES DISK_SIZE ADB_PORT VNC_PORT DATA_DIR PORT

echo "[CONFIG] RAM: ${RAM_SIZE}MB | Cores: ${CPU_CORES} | Port: ${PORT}"
echo "[CONFIG] Allow Software Emulation: ${ALLOW_SOFTWARE_EMULATION}"
echo "[CONFIG] Storage directory: ${DATA_DIR}"

# ------------------------------------------------------------------------------
# 1. Dependency Checks
# ------------------------------------------------------------------------------
echo "[CHECK] Verifying required system binaries..."
MISSING_DEPS=""
for cmd in qemu-system-x86_64 qemu-img adb node; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        MISSING_DEPS="$MISSING_DEPS $cmd"
    fi
done

if [ -n "$MISSING_DEPS" ]; then
    echo "[ERROR] Missing required dependencies:$MISSING_DEPS"
    exit 1
fi
echo "[CHECK] All required system binaries found."

# ------------------------------------------------------------------------------
# 2. Create Persistent /data Directories
# ------------------------------------------------------------------------------
echo "[INIT] Ensuring persistent directory structure under $DATA_DIR..."
mkdir -p "$DATA_DIR/android"
mkdir -p "$DATA_DIR/apks"
mkdir -p "$DATA_DIR/logs"

EMULATOR_LOG="$DATA_DIR/logs/emulator.log"
SYSTEM_LOG="$DATA_DIR/logs/system.log"
STATE_FILE="$DATA_DIR/android/device_state"

echo "STOPPED" > "$STATE_FILE"

# ------------------------------------------------------------------------------
# 3. Virtualization Capability & Railway Environment Check
# ------------------------------------------------------------------------------
echo "--------------------------------------------------------------------------------"
echo "[DIAGNOSTIC] Checking hardware virtualization capabilities..."

KVM_EXISTS=false
if [ -e "/dev/kvm" ] && [ -r "/dev/kvm" ] && [ -w "/dev/kvm" ]; then
    KVM_EXISTS=true
fi

CPU_VIRT_FLAGS=$(grep -E -m 1 'vmx|svm' /proc/cpuinfo 2>/dev/null || true)

if [ "$KVM_EXISTS" = true ]; then
    echo "[DIAGNOSTIC] SUCCESS: Hardware virtualization (/dev/kvm) is accessible!"
    echo "[DIAGNOSTIC] Virtual machine will run with native KVM acceleration."
    QEMU_ACCEL="-accel kvm"
    START_EMULATOR=true
else
    echo "================================================================================"
    echo "⚠️  [DIAGNOSTIC] HARDWARE VIRTUALIZATION (/dev/kvm) NOT DETECTED"
    echo "--------------------------------------------------------------------------------"
    echo "Host CPU flags detected: ${CPU_VIRT_FLAGS:-None (Container sandbox)}"
    echo "Device /dev/kvm: NOT ACCESSIBLE"
    echo ""
    echo "Railway Container Environment Limitation:"
    echo "Standard Railway containers run in a shared containerized Linux environment"
    echo "without nested virtualization capabilities or /dev/kvm device passthrough."
    echo ""
    if [ "$ALLOW_SOFTWARE_EMULATION" = "true" ]; then
        echo "[DIAGNOSTIC] ALLOW_SOFTWARE_EMULATION is set to 'true'."
        echo "[DIAGNOSTIC] Falling back to QEMU TCG software emulation mode."
        echo "⚠️  WARNING: Software emulation of Android is CPU-heavy and slow to boot."
        QEMU_ACCEL="-accel tcg,thread=multi"
        START_EMULATOR=true
    else
        echo "[DIAGNOSTIC] ALLOW_SOFTWARE_EMULATION is 'false' (default safe mode)."
        echo "[DIAGNOSTIC] Skipping Android VM boot to protect container CPU quotas."
        echo "[DIAGNOSTIC] The web interface and /health check will run normally."
        echo "To force software emulation, set environment variable:"
        echo "  ALLOW_SOFTWARE_EMULATION=true"
        echo "================================================================================"
        echo "MISSING_KVM" > "$STATE_FILE"
        START_EMULATOR=false
    fi
fi

# ------------------------------------------------------------------------------
# 4. Initialize Virtual Disks (if starting emulator)
# ------------------------------------------------------------------------------
QEMU_PID=""

if [ "$START_EMULATOR" = true ]; then
    echo "BOOTING" > "$STATE_FILE"

    DATA_IMAGE="$DATA_DIR/android/data.qcow2"
    if [ ! -f "$DATA_IMAGE" ]; then
        echo "[STORAGE] Initializing persistent data partition ($DATA_IMAGE, $DISK_SIZE)..."
        qemu-img create -f qcow2 "$DATA_IMAGE" "$DISK_SIZE" >> "$SYSTEM_LOG" 2>&1
    fi

    # Check for system image or create virtual disk
    SYSTEM_IMAGE="$DATA_DIR/android/system.img"
    if [ ! -f "$SYSTEM_IMAGE" ]; then
        echo "[STORAGE] Preparing base system disk ($SYSTEM_IMAGE)..."
        # If no custom image is supplied, create a bootable sparse raw disk
        qemu-img create -f qcow2 "$DATA_DIR/android/system.qcow2" 4G >> "$SYSTEM_LOG" 2>&1
        SYSTEM_IMAGE="$DATA_DIR/android/system.qcow2"
    fi

    echo "[EMULATOR] Launching Android QEMU instance..."
    echo "[EMULATOR] Accelerator: $QEMU_ACCEL | Cores: $CPU_CORES | RAM: ${RAM_SIZE}M"

    # Start QEMU in background
    # - Display: VNC on 127.0.0.1:0 (port 5900)
    # - Net: User mode with ADB port 5555 forwarded to guest port 5555
    # - Input: -usb -device usb-tablet for absolute touch/pointer coordinate mapping
    # - Graphics: -vga std
    qemu-system-x86_64 \
        $QEMU_ACCEL \
        -m "${RAM_SIZE}" \
        -smp "${CPU_CORES}" \
        -vga std \
        -usb \
        -device usb-tablet \
        -drive "file=${SYSTEM_IMAGE},if=virtio" \
        -drive "file=${DATA_IMAGE},if=virtio" \
        -net nic,model=virtio \
        -net "user,hostfwd=tcp:127.0.0.1:${ADB_PORT}-:5555" \
        -vnc "127.0.0.1:0" \
        -serial file:"$DATA_DIR/logs/qemu_serial.log" \
        > "$EMULATOR_LOG" 2>&1 &
    
    QEMU_PID=$!
    echo "[EMULATOR] QEMU started with PID $QEMU_PID"

    # Verify QEMU stayed alive
    sleep 2
    if ! kill -0 "$QEMU_PID" 2>/dev/null; then
        echo "[ERROR] QEMU failed to start or crashed immediately!" | tee -a "$SYSTEM_LOG"
        if [ -f "$EMULATOR_LOG" ]; then
            cat "$EMULATOR_LOG" | tee -a "$SYSTEM_LOG"
        fi
        echo "CRASHED" > "$STATE_FILE"
    fi

    # Start ADB daemon
    echo "[ADB] Starting local ADB server..."
    adb start-server >> "$SYSTEM_LOG" 2>&1 || true

    # Background monitoring loop for boot completion
    (
        echo "[BOOT-MONITOR] Monitoring Android boot completion..." >> "$SYSTEM_LOG"
        MAX_WAIT=120
        ELAPSED=0
        while [ $ELAPSED -lt $MAX_WAIT ]; do
            if [ -n "$QEMU_PID" ] && ! kill -0 "$QEMU_PID" 2>/dev/null; then
                echo "[BOOT-MONITOR] QEMU process terminated unexpectedly." >> "$SYSTEM_LOG"
                echo "CRASHED" > "$STATE_FILE"
                exit 1
            fi

            # Attempt to connect to local forwarded ADB port
            adb connect "127.0.0.1:${ADB_PORT}" >/dev/null 2>&1 || true
            
            BOOT_STATE=$(adb -s "127.0.0.1:${ADB_PORT}" shell getprop sys.boot_completed 2>/dev/null || true)
            BOOT_STATE=$(echo "$BOOT_STATE" | tr -d '\r\n')
            
            if [ "$BOOT_STATE" = "1" ]; then
                echo "[BOOT-MONITOR] Android successfully completed boot!" >> "$SYSTEM_LOG"
                echo "RUNNING" > "$STATE_FILE"
                exit 0
            fi
            sleep 3
            ELAPSED=$((ELAPSED + 3))
        done
        echo "[BOOT-MONITOR] Boot wait finished (or still initializing in background)." >> "$SYSTEM_LOG"
    ) &
fi

# ------------------------------------------------------------------------------
# 5. Start Web Server & Signal Handling
# ------------------------------------------------------------------------------
echo "--------------------------------------------------------------------------------"
echo "[SERVER] Starting Node.js management server on 0.0.0.0:${PORT}..."

# Setup clean trap handlers for Railway SIGTERM / SIGINT
cleanup() {
    echo ""
    echo "[SHUTDOWN] Received termination signal. Performing clean shutdown..."
    
    if [ -n "$QEMU_PID" ] && kill -0 "$QEMU_PID" 2>/dev/null; then
        echo "[SHUTDOWN] Terminating QEMU process ($QEMU_PID)..."
        kill -SIGTERM "$QEMU_PID" 2>/dev/null || true
        wait "$QEMU_PID" 2>/dev/null || true
    fi

    echo "[SHUTDOWN] Syncing disk data..."
    sync
    echo "STOPPED" > "$STATE_FILE"
    echo "[SHUTDOWN] Clean exit."
    exit 0
}

trap cleanup SIGTERM SIGINT

# Start Node server as main foreground process
cd /app/server
exec node server.js
