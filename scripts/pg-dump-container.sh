#!/bin/bash
set -euo pipefail
# Keep native client versions explicit while writing pg_dump's output on the test host.
args=()
output=
while (( $# )); do
  if [[ "$1" == --file ]]; then
    output="$2"
    shift 2
  else
    args+=("$1")
    shift
  fi
done
if [[ -n "$output" ]]; then
  docker exec "$POSTGRES_CONTAINER" pg_dump "${args[@]}" > "$output"
else
  exec docker exec "$POSTGRES_CONTAINER" pg_dump "${args[@]}"
fi
