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

# The app runs under its own service account, and PM2 keeps a separate daemon
# per user. Running pm2 as root therefore talks to root's daemon, which cannot
# see the real process: `describe` misses, so the fallback starts a SECOND copy,
# that copy loses the race for the port and crash-loops, and the app that is
# actually serving traffic never gets reloaded. Always drive the app user's
# daemon, whoever runs this script.
APP_USER="${APP_USER:-rideshare}"
if [ "$(id -un)" = "${APP_USER}" ]; then
  PM2="pm2"
elif id -u "${APP_USER}" >/dev/null 2>&1; then
  PM2="sudo -u ${APP_USER} -H pm2"
else
  echo "!! user ${APP_USER} not found; falling back to pm2 as $(id -un)" >&2
  PM2="pm2"
fi

echo "==> Restarting ${PM2_NAME} via ${APP_USER}'s PM2 daemon"
${PM2} describe "${PM2_NAME}" >/dev/null 2>&1 \
  && ${PM2} reload "${PM2_NAME}" --update-env \
  || ${PM2} start server.js --name "${PM2_NAME}"
${PM2} save

echo "==> Deployed $(git rev-parse --short HEAD) on ${BRANCH}"
