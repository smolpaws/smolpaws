#!/usr/bin/env bash
# Sourced after loading the caller's env. ROOT_DIR is the SmolPaws checkout.
# Both bridge and heartbeat startup must require the same product composition.
ensure_smolpaws_product_server() {
  local server_url="${1%/}"
  local health_url="$server_url/health"
  local log_dir="${SMOLPAWS_HOME_DIR}/logs"
  export PERSISTENCE_DIR="${PERSISTENCE_DIR:-$SMOLPAWS_HOME_DIR/conversations}"
  export SMOLPAWS_BUILD_SHA="${SMOLPAWS_BUILD_SHA:-$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || printf 'unknown')}"
  mkdir -p "$log_dir" "$PERSISTENCE_DIR"

  # Return 2 for a live but incompatible server: never spawn a competitor on its port.
  smolpaws_product_health() {
    local headers
    headers="$(curl -fsSI --max-time 2 "$health_url")" || return 1
    if ! printf '%s\n' "$headers" | grep -qi '^x-smolpaws-host: relay'; then
      echo "[smolpaws] $server_url is healthy but is not the SmolPaws product server; upgrade that host before starting this client." >&2
      return 2
    fi
  }
  local status=0
  smolpaws_product_health || status=$?
  if [[ "$status" -eq 0 ]]; then return 0; fi
  if [[ "$status" -eq 2 ]]; then return 1; fi
  case "$server_url" in
    http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
    *) echo "[smolpaws] product server unavailable at $server_url; start the remote host separately." >&2; return 1 ;;
  esac

  local port="${server_url##*:}"
  export OPENHANDS_AGENT_SERVER_PORT="$port"
  export OPENHANDS_AGENT_SERVER_HOST="${OPENHANDS_AGENT_SERVER_HOST:-127.0.0.1}"
  echo "[smolpaws] starting supervised product server at $server_url" >&2
  nohup node --import tsx/esm "$ROOT_DIR/apps/relay-server/src/supervise.ts" \
    >>"$log_dir/openhands-agent-server-$port.log" 2>&1 </dev/null &
  disown || true
  local i
  for i in $(seq 1 120); do
    status=0
    smolpaws_product_health || status=$?
    if [[ "$status" -eq 0 ]]; then return 0; fi
    if [[ "$status" -eq 2 ]]; then return 1; fi
    sleep 0.5
  done
  echo "[smolpaws] product server did not become healthy; see $log_dir/openhands-agent-server-$port.log" >&2
  return 1
}
