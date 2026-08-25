#!/usr/bin/env bash
#
# Verify (or apply) the env values that MUST survive a release cutover.
# Policy and evidence live in deploy/required-env.json — this script only enforces it.
#
#   deploy/apply-required-env.sh --check <path/to/.env> [id]   # exit 1 if anything drifted
#   deploy/apply-required-env.sh --apply <path/to/.env> [id]   # back up, then set what drifted
#
# The optional instance id merges instances.<id>.extra on top of shared. This rollout has no
# instance override because TESTNET and LIVE must run identical strategy settings.
#
# WHY THIS EXISTS: a release dir gets a REAL .env, not a symlink. A cutover that forgets to carry
# these forward reverts them to code defaults, and nothing fails loudly — the 36h hold policy was
# lost exactly this way on 2026-08-05. Run --check after EVERY cutover, before arming.
#
# It never deletes a key. Deleting is not the same as disabling here: removing the numeric TP env
# silently falls back to 0.60% rather than switching the TP off.
#
set -euo pipefail

mode="${1:-}"
target="${2:-}"
instance="${3:-}"   # optional: merge instances.<id>.extra on top of shared
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
policy="$here/required-env.json"

case "$mode" in
  --check|--apply) ;;
  *) echo "usage: $0 --check|--apply <path/to/.env> [instance-id]" >&2; exit 2 ;;
esac
[ -n "$target" ] || { echo "usage: $0 $mode <path/to/.env>" >&2; exit 2; }
[ -f "$target" ] || { echo "ABORT: no such .env: $target" >&2; exit 2; }
[ -f "$policy" ] || { echo "ABORT: policy missing: $policy" >&2; exit 2; }

# Everything NOT under policy must survive byte-identical; proven by hashing it before and after.
before_others="$(python3 - "$target" "$policy" "$instance" <<'PY'
import json,sys,hashlib
env,pol,inst=sys.argv[1],sys.argv[2],(sys.argv[3] if len(sys.argv)>3 else "")
d=json.load(open(pol))
keys=set(d["shared"])|set(((d.get("instances") or {}).get(inst) or {}).get("extra") or {})
rest=[l for l in open(env,encoding="utf-8").read().split("\n")
      if l.split("=",1)[0] not in keys]
print(hashlib.sha256("\n".join(rest).encode()).hexdigest())
PY
)"

if [ "$mode" = "--apply" ]; then
  bak="$target.bak-requiredenv-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$target" "$bak"
  echo "  backup: $bak"
fi

python3 - "$target" "$policy" "$mode" "$instance" <<'PY'
import json,sys,re
env,pol,mode=sys.argv[1],sys.argv[2],sys.argv[3]
inst=sys.argv[4] if len(sys.argv)>4 else ""
d=json.load(open(pol))
want={k:v["value"] for k,v in d["shared"].items()}
want.update({k:v["value"] for k,v in (((d.get("instances") or {}).get(inst) or {}).get("extra") or {}).items()})
text=open(env,encoding="utf-8").read()
lines=text.split("\n")
cur={}
for l in lines:
    if "=" in l and not l.lstrip().startswith("#"):
        k,v=l.split("=",1)
        if k in want: cur[k]=v
drift=[(k,cur.get(k),v) for k,v in want.items() if cur.get(k)!=v]
if not drift:
    print("  OK: all %d required values already correct" % len(want)); sys.exit(0)
for k,got,exp in drift:
    print("  DRIFT %-46s %-14s -> %s" % (k, got if got is not None else "<unset>", exp))
if mode=="--check":
    print("  %d value(s) drifted — run with --apply to fix" % len(drift)); sys.exit(1)
out=[];seen=set()
for l in lines:
    k=l.split("=",1)[0] if "=" in l else None
    if k in want and not l.lstrip().startswith("#"):
        l="%s=%s"%(k,want[k]); seen.add(k)
    out.append(l)
for k,v in want.items():
    if k not in seen:
        while out and out[-1].strip()=="": out.pop()
        out.append("%s=%s"%(k,v))
t="\n".join(out)
if not t.endswith("\n"): t+="\n"
open(env,"w",encoding="utf-8").write(t)
print("  applied %d value(s)" % len(drift))
PY
rc=$?

if [ "$mode" = "--apply" ]; then
  after_others="$(python3 - "$target" "$policy" "$instance" <<'PY'
import json,sys,hashlib
env,pol,inst=sys.argv[1],sys.argv[2],(sys.argv[3] if len(sys.argv)>3 else "")
d=json.load(open(pol))
keys=set(d["shared"])|set(((d.get("instances") or {}).get(inst) or {}).get("extra") or {})
rest=[l for l in open(env,encoding="utf-8").read().split("\n")
      if l.split("=",1)[0] not in keys]
print(hashlib.sha256("\n".join(rest).encode()).hexdigest())
PY
)"
  if [ "$before_others" != "$after_others" ]; then
    echo "  ABORT: lines outside the policy changed — restore from the backup above" >&2
    exit 3
  fi
  echo "  verified: every line outside the policy is byte-identical"
  echo "  NOTE: restart the instance — these are read once at process start."
fi
exit $rc
