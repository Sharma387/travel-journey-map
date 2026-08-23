SHELL := /bin/sh

.PHONY: install backend frontend dev run clean

# Install backend (venv) and frontend (npm) dependencies.
install:
	python3 -m venv backend/.venv
	backend/.venv/bin/pip install --upgrade pip
	backend/.venv/bin/pip install -r backend/requirements.txt
	cd frontend && npm install

# Run only the FastAPI backend on port 8000.
backend:
	cd backend && .venv/bin/uvicorn main:app --reload --host 127.0.0.1 --port 8000

# Run only the Vite dev server on port 5173 (proxies /api -> 8000).
frontend:
	cd frontend && npm run dev

# Run backend and frontend concurrently. Ctrl-C stops both.
dev:
	@trap 'kill 0' INT TERM EXIT; \
	$(MAKE) backend & \
	$(MAKE) frontend & \
	wait

# One-command launcher: frees ports 8000/5173, starts both servers, opens the browser.
run:
	./run.sh

# Remove all generated artefacts.
clean:
	rm -rf backend/.venv backend/__pycache__ backend/geocoding_cache.db* \
	       frontend/node_modules frontend/dist