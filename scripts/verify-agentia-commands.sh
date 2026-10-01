#!/bin/sh
# Prints the help text for every Agentia command Sunset uses, into agentia-help.txt.
# Compare the flags with the "commands" templates in src/core/config.ts (DEFAULT_COMMANDS).
# If a flag differs, override that template in your project's .sunset.json.
OUT="agentia-help.txt"
: > "$OUT"
for c in "auth get" "cicd work list" "cicd work get" "cicd work create" "cicd work update" \
         "cicd work commit" "cicd work promote" "cicd promotion list" "cicd promotion run" \
         "cicd metadata dependency list" "cicd metadata content get" \
         "cicd environment list" "cicd credential list" "cicd pipeline list" "cicd pipeline connection list" \
         "cicd project list" "cicd project default set" "cicd work deployment-step list" "ai agent ask" \
         "testing job list" "testing job run" "testing build get" "testing build logs"; do
  echo "=================== agentia $c --help" >> "$OUT"
  agentia $c --help >> "$OUT" 2>&1 || echo "(command not found in this version)" >> "$OUT"
done
echo "Also listing all commands:" >> "$OUT"
agentia commands >> "$OUT" 2>&1 || agentia --help >> "$OUT" 2>&1
echo "Wrote $OUT"
