#!/usr/bin/env bash
set -euo pipefail

normalize_db_path() {
  local path=${1% (deleted)}
  path=${path%-wal}
  path=${path%-shm}
  printf '%s\n' "$path"
}

parse_db_path() {
  printf '%s\n' "$1" | xargs -n1 2>/dev/null | sed -n 's/^DB_PATH=//p' | head -n 1
}

if [[ ${1:-} == '--normalize' ]]; then
  normalize_db_path "${2:?path required}"
  exit
fi
if [[ ${1:-} == '--parse-env' ]]; then
  parse_db_path "${2:-}"
  exit
fi

service=${1:-tokember}
proc_root=${PROC_ROOT:-/proc}
systemctl_bin=${SYSTEMCTL_BIN:-systemctl}

main_pid=$($systemctl_bin show "$service" -p MainPID --value 2>/dev/null || true)
if [[ $main_pid =~ ^[1-9][0-9]*$ && -d "$proc_root/$main_pid/fd" ]]; then
  for descriptor in "$proc_root/$main_pid/fd"/*; do
    target=$(readlink -f "$descriptor" 2>/dev/null || true)
    case "$target" in
      *.db|*.db-wal|*.db-shm|*.db\ \(deleted\))
        candidate=$(normalize_db_path "$target")
        if [[ -f "$candidate" ]]; then
          printf '%s\n' "$candidate"
          exit
        fi
        ;;
    esac
  done
fi

service_env=$($systemctl_bin show "$service" -p Environment --value 2>/dev/null || true)
db_path=$(parse_db_path "$service_env")
working_dir=$($systemctl_bin show "$service" -p WorkingDirectory --value 2>/dev/null || true)
if [[ -n "$db_path" && ${db_path#/} == "$db_path" ]]; then
  db_path="$working_dir/$db_path"
fi
if [[ -n "$db_path" && -f "$db_path" ]]; then
  printf '%s\n' "$db_path"
  exit
fi
for name in tokember.db ai-burn.db; do
  if [[ -n "$working_dir" && -f "$working_dir/$name" ]]; then
    printf '%s\n' "$working_dir/$name"
    exit
  fi
done

search_roots=${TOKEMBER_DB_SEARCH_ROOTS:-${AI_BURN_DB_SEARCH_ROOTS:-'/opt/tokember /opt/ai-burn /data'}}
mapfile -t matches < <(find $search_roots -maxdepth 5 -type f -name '*.db' 2>/dev/null | sort -u)
if [[ ${#matches[@]} -eq 1 ]]; then
  printf '%s\n' "${matches[0]}"
  exit
fi

echo "Unable to identify a unique SQLite database for $service" >&2
if [[ ${#matches[@]} -gt 1 ]]; then
  printf 'Candidates:\n' >&2
  printf '  %s\n' "${matches[@]}" >&2
fi
exit 1
