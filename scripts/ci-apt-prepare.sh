#!/usr/bin/env bash
#
# Make apt give up on a stalled mirror quickly instead of waiting out the job.
#
# Retries and timeouts apply per file inside one apt run; scripts/ci-retry.sh
# bounds the whole run. The Microsoft package source is dropped because no job
# installs from it, yet a refusal from it fails every `apt-get update`.
#
set -euo pipefail

sudo tee /etc/apt/apt.conf.d/80-ci-retries >/dev/null <<'CONF'
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
CONF

sudo rm -f /etc/apt/sources.list.d/microsoft-prod.list /etc/apt/sources.list.d/microsoft-prod.sources
