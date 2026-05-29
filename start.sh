#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Load repo `.env` (if present) for local dev.
# Note: this uses `source`, so do not run with an untrusted `.env` file.
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/.env"
  set +a
fi

FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_DIR="$ROOT_DIR/backend"
GATEWAY_DIR="$ROOT_DIR/gateway"

BACKEND_PORT="${BACKEND_PORT:-5000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
GATEWAY_PORT="${GATEWAY_PORT:-3001}"

pick_free_port() {
  local preferred_port="$1"
  local max_attempts="${2:-20}"

  local py=""
  if command -v python3 >/dev/null 2>&1; then
    py="python3"
  elif command -v python >/dev/null 2>&1; then
    py="python"
  elif command -v py >/dev/null 2>&1; then
    py="py"
  else
    echo "ERROR: Python not found (need 'python3', 'python', or 'py' on PATH)." >&2
    return 1
  fi

  "$py" -c $'import socket, sys\nstart=int(sys.argv[1]); max_attempts=int(sys.argv[2])\nfor p in range(start, start+max_attempts):\n    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:\n        try:\n            s.bind(("127.0.0.1", p))\n        except OSError:\n            continue\n        print(p)\n        raise SystemExit(0)\nraise SystemExit(1)' "$preferred_port" "$max_attempts"
}

PREFERRED_FRONTEND_PORT="$FRONTEND_PORT"
FRONTEND_PORT="$(pick_free_port "$PREFERRED_FRONTEND_PORT" 50)"
if [[ "$FRONTEND_PORT" != "$PREFERRED_FRONTEND_PORT" ]]; then
  echo "Note: frontend port ${PREFERRED_FRONTEND_PORT} is already in use; using ${FRONTEND_PORT} instead."
fi
export FRONTEND_PORT

FRONTEND_URL="http://127.0.0.1:${FRONTEND_PORT}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"

export GATEWAY_BASE_URL="${GATEWAY_BASE_URL:-${GATEWAY_URL}}"
export BACKEND_WEBHOOK_URL="${BACKEND_WEBHOOK_URL:-${BACKEND_URL}/webhook}"

is_windows=false
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*) is_windows=true ;;
esac

backend_pid=""
gateway_pid=""
frontend_pid=""

cleanup() {
  set +e
  if [[ -n "${frontend_pid}" ]] && kill -0 "${frontend_pid}" 2>/dev/null; then
    kill "${frontend_pid}" 2>/dev/null || true
  fi
  if [[ -n "${gateway_pid}" ]] && kill -0 "${gateway_pid}" 2>/dev/null; then
    kill "${gateway_pid}" 2>/dev/null || true
  fi
  if [[ -n "${backend_pid}" ]] && kill -0 "${backend_pid}" 2>/dev/null; then
    kill "${backend_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "Starting backend (Flask) at ${BACKEND_URL} ..."
cd "$BACKEND_DIR"

if [[ "$is_windows" == "true" ]]; then
  PY_EXE="python"
  if command -v py >/dev/null 2>&1; then PY_EXE="py"; fi
  # FIXED: Check for .venv instead of venv
  if [[ ! -d ".venv" ]]; then
    "$PY_EXE" -m venv .venv
  fi
  # FIXED: Use .venv instead of venv
  if [[ ! -x ".venv/Scripts/python.exe" ]]; then
    echo "ERROR: backend venv missing python.exe at .venv/Scripts/python.exe"
    exit 1
  fi
  if [[ ! -f ".venv/.deps_installed" ]]; then
    .venv/Scripts/pip.exe install -r requirements.txt
    : > .venv/.deps_installed
  fi
  .venv/Scripts/python.exe app.py &
else
  PY_EXE="python3"
  if command -v python3 >/dev/null 2>&1; then PY_EXE="python3"; elif command -v python >/dev/null 2>&1; then PY_EXE="python"; fi
  # FIXED: Check for .venv instead of venv
  if [[ ! -d ".venv" ]]; then
    "$PY_EXE" -m venv .venv
  fi
  # FIXED: Use .venv instead of venv
  if [[ ! -x ".venv/bin/python" ]]; then
    echo "ERROR: backend venv missing python at .venv/bin/python"
    exit 1
  fi
  if [[ ! -f ".venv/.deps_installed" ]]; then
    .venv/bin/pip install -r requirements.txt
    : > .venv/.deps_installed
  fi
  .venv/bin/python app.py &
fi

backend_pid=$!

echo "Starting gateway (whatsapp-web.js) at ${GATEWAY_URL} ..."
cd "$GATEWAY_DIR"

NPM_CMD="npm"
if [[ "$is_windows" == "true" ]] && command -v npm.cmd >/dev/null 2>&1; then
  NPM_CMD="npm.cmd"
fi

if [[ ! -d "node_modules" ]]; then
  "$NPM_CMD" install
fi

"$NPM_CMD" run start &
gateway_pid=$!

echo "Starting frontend (Vite) at ${FRONTEND_URL} ..."
cd "$FRONTEND_DIR"

NPM_CMD="npm"
if [[ "$is_windows" == "true" ]] && command -v npm.cmd >/dev/null 2>&1; then
  # In some Windows shells, `npm` may resolve to a blocked PowerShell script.
  NPM_CMD="npm.cmd"
fi

if [[ ! -d "node_modules" ]]; then
  "$NPM_CMD" install
fi

"$NPM_CMD" run dev -- --port "$FRONTEND_PORT" --strictPort &
frontend_pid=$!

cat <<EOF

All set.
- Frontend: ${FRONTEND_URL}
- Backend:  ${BACKEND_URL}/api/health
- Gateway:  ${GATEWAY_URL}/status

Press Ctrl+C to stop all.
EOF

wait