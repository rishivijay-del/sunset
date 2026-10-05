#!/bin/bash
# Sunset demo 2 setup: hero field Account.Market_Zone__c
# Run from your pipeline repo:   cd ~/sunset-work/pipeline && ../sunset/scripts/setup-demo2.sh
# Each stage prints ===== STAGE n. To resume from a stage: START=6 ../sunset/scripts/setup-demo2.sh
set -e
START="${START:-1}"
run() { [ "$1" -ge "$START" ]; }
KIT="$(cd "$(dirname "$0")/../demo2" && pwd)"
PIPE="$(pwd)"
ORGS="sunset-dev1 sunset-int sunset-uat sunset-prod"
DEV2_CREDENTIAL="a11hm0000017avpAAA"
PROJECT_ID="a15hm000000bpUzAAI"

[ -f "$PIPE/.sunset.json" ] || { echo "Run this from ~/sunset-work/pipeline (no .sunset.json here)"; exit 1; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Your pipeline repo has uncommitted changes. Run: git status   (then commit or 'git stash') and re-run."; exit 1
fi

if run 1; then
echo "===== STAGE 1: set aside earlier Sunset runs"
mkdir -p .sunset/archive
for x in plans capsules reports tombstones.json last-restore.json; do
  [ -e ".sunset/$x" ] && mv ".sunset/$x" ".sunset/archive/$x-$(date +%s)" || true
done
ls .sunset
fi

if run 2; then
echo "===== STAGE 2: deploy the demo 2 metadata to every org"
for a in $ORGS sunset-dev2; do
  echo "--- $a"
  (cd "$KIT" && sf project deploy start --source-dir force-app -o "$a" --ignore-conflicts --wait 30) | grep -E "Status:|Problem|Error" || true
  sf org assign permset --name Zone_Demo_Access -o "$a" >/dev/null 2>&1 || true
done
fi

if run 3; then
echo "===== STAGE 3: give 3 accounts a Market Zone (0.3%)"
for a in $ORGS; do
  echo "--- $a"
  sf apex run --file "$KIT/scripts/set-zone-data.apex" -o "$a" | grep -E "Zoned|rror" || true
done
fi

if run 4; then
echo "===== STAGE 4: create obsolete Flow versions (Dev1 and Production)"
TMP=$(mktemp -d)
mkdir -p "$TMP/force-app/main/default/flows"
cp "$KIT/force-app/main/default/flows/Account_Zone_Sync.flow-meta.xml" "$TMP/force-app/main/default/flows/"
sed -i '' 's#<label>Set Zone Defaults</label>#<label>Set Zone Defaults v2</label>#' "$TMP/force-app/main/default/flows/Account_Zone_Sync.flow-meta.xml"
echo '{"packageDirectories":[{"path":"force-app","default":true}],"sourceApiVersion":"62.0"}' > "$TMP/sfdx-project.json"
for a in sunset-dev1 sunset-prod; do
  echo "--- $a"
  (cd "$TMP" && sf project deploy start --source-dir force-app -o "$a" --ignore-conflicts --wait 20) | grep -E "Status:" || true
  (cd "$KIT" && sf project deploy start --source-dir force-app/main/default/flows -o "$a" --ignore-conflicts --wait 20) | grep -E "Status:" || true
  sf data query --use-tooling-api -q "SELECT VersionNumber, Status FROM Flow WHERE Definition.DeveloperName = 'Account_Zone_Sync' ORDER BY VersionNumber" -o "$a" | grep -E "Active|Obsolete" || true
done
fi

if run 5; then
echo "===== STAGE 5: put demo 2 into Git (main, then every environment branch)"
git fetch --all -q
git checkout -q main && git pull -q
cp -R "$KIT/force-app/." force-app/
mkdir -p sunset-demo/scripts && cp "$KIT/scripts/"*.apex sunset-demo/scripts/
git add -A force-app sunset-demo
git commit -q -m "Demo 2 baseline: Market_Zone__c" || echo "(nothing new to commit on main)"
git push -q
for b in uat-sfp int-sfp dev1-sfp dev2-sfp hotfix-sfp; do
  echo "--- $b"
  git checkout -q "$b"
  git pull -q
  # Keep the branch's own version if a file conflicts (e.g. the teammate's change on dev2-sfp)
  git merge -q -X ours main -m "Demo 2 baseline to $b"
  git push -q
done
git checkout -q dev1-sfp
fi

if run 6; then
echo "===== STAGE 6: ignore the data load we just did (usage.ignoreWritesBefore = now)"
python3 - <<'PY'
import json, datetime
p = '.sunset.json'
c = json.load(open(p))
c.setdefault('usage', {})['ignoreWritesBefore'] = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump(c, open(p, 'w'), indent=2)
open(p, 'a').write('\n')
print('ignoreWritesBefore =', c['usage']['ignoreWritesBefore'])
PY
git add .sunset.json && git commit -q -m "Demo 2: reset ignoreWritesBefore" && git push -q
fi

if run 7; then
echo "===== STAGE 7: spring the trap (fake integration writes Sync_Status__c) after a 60s pause"
sleep 60
for a in sunset-prod sunset-dev1; do
  sf apex run --file sunset-demo/scripts/trap-integration-writes.apex -o "$a" | grep -E "Updated|rror" || true
done
fi

if run 8; then
echo "===== STAGE 8: the teammate's unfinished story in Dev2 (touches ZoneRouter)"
STORY_JSON=$(agentia cicd work create --title "Route LATAM accounts" --project "$PROJECT_ID" --source-credential "$DEV2_CREDENTIAL" --json)
STORY_ID=$(echo "$STORY_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',d); r=r[0] if isinstance(r,list) else r; print(r.get('id') or r.get('Id'))")
STORY_NAME=$(echo "$STORY_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',d); r=r[0] if isinstance(r,list) else r; print(r.get('name') or r.get('Name'))")
echo "Teammate story: $STORY_NAME ($STORY_ID)"
TM=$(mktemp -d)
mkdir -p "$TM/force-app/main/default/classes"
cp "$KIT/force-app/main/default/classes/ZoneRouter.cls" "$KIT/force-app/main/default/classes/ZoneRouter.cls-meta.xml" "$TM/force-app/main/default/classes/"
sed -i '' "s/'EMEA'/'LATAM'/" "$TM/force-app/main/default/classes/ZoneRouter.cls"
echo '{"packageDirectories":[{"path":"force-app","default":true}],"sourceApiVersion":"62.0"}' > "$TM/sfdx-project.json"
(cd "$TM" && sf project deploy start --source-dir force-app -o sunset-dev2 --ignore-conflicts --wait 20) | grep -E "Status:" || true
agentia cicd work commit "$STORY_ID" --cloud --message "Route LATAM accounts" --metadata-type ApexClass --metadata-name ZoneRouter --metadata-category SFDX --action Add --wait --json > /tmp/teammate-zone-commit.json 2>&1 && echo "Teammate commit done" || echo "Teammate commit FAILED: see /tmp/teammate-zone-commit.json"
git fetch -q --all
git branch -r | grep "feature/$STORY_NAME" || echo "(feature branch not visible yet; run: git fetch --all && git branch -r | grep $STORY_NAME)"

fi

echo
echo "===== DONE. Demo 2 is ready."
echo "Check:   agentia sunset investigate Account.Market_Zone__c | head -8     (expect CAUTION)"
echo "         agentia sunset investigate Account.Sync_Status__c | head -5     (expect BLOCKED)"
echo "Teammate story for the collision demo: $STORY_NAME"
