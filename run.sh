#!/bin/sh
# Travel Journey Map — one-command launcher.
#
#   ./run.sh
#
# Frees ports 8000/5173 (kills stale processes), starts the FastAPI backend
# and the Vite frontend, then opens the browser. Ctrl-C stops both.

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PORT="${PORT:-8000}"
FRONTEND_PORT=5173

# --- Dependencies present? -------------------------------------------------
if [ ! -x "$ROOT/backend/.venv/bin/uvicorn" ]; then
  echo "Backend dependencies missing — run: make install" >&2
  exit 1
fi
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "Frontend dependencies missing — run: make install" >&2
  exit 1
fi

# --- Kill anything already on the ports ------------------------------------
kill_port() {
  port="$1"
  pids="$(lsof -ti ":$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "==> Port $port busy — killing PID(s): $pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}
kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"

# --- Cleanup on exit (Ctrl-C) ----------------------------------------------
cleanup() {
  echo ""
  echo "==> Stopping..."
  trap - INT TERM EXIT
  for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
    pids="$(lsof -ti ":$port" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
    fi
  done
  exit 0
}
trap cleanup INT TERM EXIT

# --- Start backend + frontend ----------------------------------------------
echo "==> Starting backend on :$BACKEND_PORT"
(
  cd "$ROOT/backend" || exit 1
  exec .venv/bin/uvicorn main:app --host 127.0.0.1 --port "$BACKEND_PORT"
) &
BACK_PID=$!

echo "==> Starting frontend on :$FRONTEND_PORT"
(
  cd "$ROOT/frontend" || exit 1
  exec npm run dev
) &
FRONT_PID=$!

# Wait for the backend to answer.
i=0
while [ "$i" -lt 30 ]; do
  if curl -s -o /dev/null "http://127.0.0.1:$BACKEND_PORT/api/health"; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

echo ""
echo "=============================================="
echo "  🗺️  Travel Journey Map is running"
echo "     →  http://localhost:$FRONTEND_PORT"
echo "     (backend: http://127.0.0.1:$BACKEND_PORT)"
echo "  Press Ctrl-C to stop both servers."
echo "=============================================="
echo ""

# Open the browser (macOS).
command -v open >/dev/null 2>&1 && open "http://localhost:$FRONTEND_PORT" || true

wait "$BACK_PID" "$FRONT_PID"
