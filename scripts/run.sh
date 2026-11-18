#!/bin/zsh
# Usage: scripts/run.sh serve|hourly|daily   (called by launchd; logs to data/logs/)
cd "$(dirname "$0")/.." || exit 1
mkdir -p data/logs
exec .venv/bin/python -m ubike "$@" >> "data/logs/$1.log" 2>&1
