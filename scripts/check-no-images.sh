#!/bin/bash
# Fails if a disk image, ROM or save state is staged or tracked. Commercial
# software (and real ROM dumps) must never be committed; see fixtures/README.md.
set -euo pipefail
pattern='\.(fdi|d88|88d|d98|98d|hdm|xdf|dup|nfd|hdi|nhd|thd|vhd|rom|np2|img|ima)$'
files=$( { git diff --cached --name-only --diff-filter=AM 2>/dev/null; git ls-files; } | sort -u | grep -iE "$pattern" || true)
if [ -n "$files" ]; then
  echo "Refusing to commit disk images / ROMs:" >&2
  echo "$files" >&2
  exit 1
fi
