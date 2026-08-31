#!/usr/bin/env bash
#
# Deploy the NationalLifeCoverage quote app to the Hetzner host.
#
# This replaces the previous DigitalOcean script, which hard-coded a dead server
# IP (45.32.175.55), embedded an IPStack API key and a JWT secret in plaintext,
# and used GitHub Actions ${{ }} interpolation inside a bash heredoc (which the
# shell never expands, so the SSH password was always literal).
#
# This script runs ON the server and takes every environment-specific value from
# the environment. It never writes secrets: /opt/rideshare/.env is provisioned
# once, out of band, and is left untouched here.
#
# Usage (on the server):
#   APP_DIR=/opt/rideshare BRANCH=main ./deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rideshare}"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-https://github.com/bbarnes4318/rideshare.git}"
PM2_NAME="${PM2_NAME:-rideshare-analytics}"

echo "==> Deploying ${BRANCH} to ${APP_DIR}"

if [ ! -d "${APP_DIR}/.git" ]; then
  git clone "${REPO_URL}" "${APP_DIR}"
fi

cd "${APP_DIR}"
git fetch origin --prune
git checkout "${BRANCH}"
git reset --hard "origin/${BRANCH}"

echo "==> Installing production dependencies"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

mkdir -p exports

if [ ! -f "${APP_DIR}/.env" ]; then
  echo "!! ${APP_DIR}/.env is missing. Create it before starting the app." >&2
  exit 1
fi

echo "==> Restarting ${PM2_NAME}"
pm2 describe "${PM2_NAME}" >/dev/null 2>&1 \
  && pm2 reload "${PM2_NAME}" --update-env \
  || pm2 start server.js --name "${PM2_NAME}"
pm2 save

echo "==> Deployed $(git rev-parse --short HEAD) on ${BRANCH}"
