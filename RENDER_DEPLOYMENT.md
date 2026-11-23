# Render deployment notes (Copilot + OCR)

## Backend service
- Create a **Docker** web service using `backend/Dockerfile` as the Dockerfile path.
- Set the health check path to `/api/health`.
- Ensure the service is allowed to bind to Render's `PORT` environment variable (the server reads `process.env.PORT`).
- Set `NODE_ENV=production`, `JWT_SECRET` (a long random secret), `MONGODB_URI`, and `CORS_ORIGIN` (the deployed frontend origin).
- Set `COPILOT_MODEL=auto` (or leave it blank to use the Copilot CLI default), `COPILOT_TIMEOUT=240`, and `AGENT_LLM_TIMEOUT_MS=240000`.
- OCR runtime is installed by the Dockerfile: Python, Tesseract English data, and Poppler. The Dockerfile sets `PYTHON_BIN` and `TESSERACT_PATH`.

## Oracle PO API
Set `ORACLE_PO_DETAILS_URL`, `ORACLE_PO_API_USERNAME`, and `ORACLE_PO_API_PASSWORD` as Render environment secrets. If the Oracle endpoint uses a private certificate authority, obtain the PEM CA chain from the Oracle/IT team and configure it as a Render Secret File; do not disable TLS certificate verification.

## Frontend
Deploy the frontend as a Render Static Site using its existing build command and publish directory. Set its API base URL (the exact variable name used by the frontend) to the backend service URL, and set backend `CORS_ORIGIN` to the frontend URL.

## Important: Copilot CLI authentication
Installing `@github/copilot` in the image does **not** by itself authenticate the CLI. Configure authentication using a GitHub-supported Copilot CLI authentication method suitable for non-interactive/server use and ensure the account has Copilot access. Do not put a personal password or an interactive login session into source control. Confirm the CLI can authenticate in the deployed container before testing extraction.

## Uploaded-file persistence
Render's container filesystem is ephemeral by default. Configure a persistent disk for uploaded files or move uploads to durable object storage. Keep MongoDB metadata separate from the file bytes.

## Health check
After deployment, open `https://YOUR-BACKEND.onrender.com/api/health`. Expected JSON includes `status: "ok"`.
