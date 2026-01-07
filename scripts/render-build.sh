#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="public"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

cp index.html "$OUT_DIR"/
cp styles.css "$OUT_DIR"/
cp sidebar.css "$OUT_DIR"/

# Copy supporting assets
cp -R src "$OUT_DIR"/
cp -R assets "$OUT_DIR"/

# Render env vars into a runtime-friendly config file for static hosting.
ENV_FILE="$OUT_DIR/assets/env.js"
if [[ -n "${VITE_FIREBASE_API_KEY:-}" || -n "${REACT_APP_FIREBASE_API_KEY:-}" || -n "${FIREBASE_API_KEY:-}" ]]; then
  cat > "$ENV_FILE" <<EOF
window.__ENV = {
  VITE_FIREBASE_API_KEY: "${VITE_FIREBASE_API_KEY:-${REACT_APP_FIREBASE_API_KEY:-${FIREBASE_API_KEY:-}}}",
  VITE_FIREBASE_AUTH_DOMAIN: "${VITE_FIREBASE_AUTH_DOMAIN:-${REACT_APP_FIREBASE_AUTH_DOMAIN:-${FIREBASE_AUTH_DOMAIN:-}}}",
  VITE_FIREBASE_PROJECT_ID: "${VITE_FIREBASE_PROJECT_ID:-${REACT_APP_FIREBASE_PROJECT_ID:-${FIREBASE_PROJECT_ID:-}}}",
  VITE_FIREBASE_STORAGE_BUCKET: "${VITE_FIREBASE_STORAGE_BUCKET:-${REACT_APP_FIREBASE_STORAGE_BUCKET:-${FIREBASE_STORAGE_BUCKET:-}}}",
  VITE_FIREBASE_MESSAGING_SENDER_ID: "${VITE_FIREBASE_MESSAGING_SENDER_ID:-${REACT_APP_FIREBASE_MESSAGING_SENDER_ID:-${FIREBASE_MESSAGING_SENDER_ID:-}}}",
  VITE_FIREBASE_APP_ID: "${VITE_FIREBASE_APP_ID:-${REACT_APP_FIREBASE_APP_ID:-${FIREBASE_APP_ID:-}}}",
  VITE_FIREBASE_MEASUREMENT_ID: "${VITE_FIREBASE_MEASUREMENT_ID:-${REACT_APP_FIREBASE_MEASUREMENT_ID:-${FIREBASE_MEASUREMENT_ID:-}}}"
};
EOF
else
  cat > "$ENV_FILE" <<'EOF'
window.__ENV = window.__ENV || {};
EOF
fi

# Include docs or JSON imports if they exist and are needed for downloads
if [ -d "JSON" ]; then
  cp -R JSON "$OUT_DIR"/
fi

if [ -d "JSON Backup" ]; then
  cp -R "JSON Backup" "$OUT_DIR"/
fi
