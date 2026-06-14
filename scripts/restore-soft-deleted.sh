#!/usr/bin/env bash
#
# Restore soft-deleted objects in a GCS bucket (the ones "waiting for final
# deletion"). Lists them first; restores each by its generation so live objects
# are never touched.
#
# Requires a recent gcloud (`gcloud components update`) and an account with
# storage.objects.restore on the bucket.
#
# Usage:
#   ./scripts/restore-soft-deleted.sh                       # dry run, whole bucket
#   RESTORE=1 ./scripts/restore-soft-deleted.sh             # actually restore, whole bucket
#   RESTORE=1 ./scripts/restore-soft-deleted.sh gs://b store/   # only the store/ prefix
#
# Args:   [BUCKET_URL] [PREFIX]
# Env:    RESTORE=1 to perform the restore (otherwise dry run)
#         PARALLEL=N concurrent restores (default 8)
set -euo pipefail

BUCKET="${1:-gs://compilator-83816.appspot.com}"
PREFIX="${2:-}"
PARALLEL="${PARALLEL:-4}"   # concurrent gcloud calls
BATCH="${BATCH:-100}"       # objects restored per gcloud call

echo "Scanning soft-deleted objects under ${BUCKET}/${PREFIX:-<all>} ..."

# --soft-deleted lists only soft-deleted versions; each URL carries its #generation.
LIST="$(gcloud storage ls --soft-deleted --recursive "${BUCKET}/${PREFIX}**" 2>/dev/null | grep -E '^gs://' || true)"
COUNT="$(printf '%s' "$LIST" | grep -c . || true)"

if [ -z "$LIST" ] || [ "$COUNT" -eq 0 ]; then
  echo "No soft-deleted objects found — nothing to restore."
  echo "(If you expected some, soft delete may be off, or the retention window has passed.)"
  exit 0
fi

echo "Found ${COUNT} soft-deleted object(s)."

if [ "${RESTORE:-0}" != "1" ]; then
  echo
  printf '%s\n' "$LIST"
  echo
  echo "DRY RUN. Re-run with:  RESTORE=1 $0 ${1:-} ${2:-}"
  exit 0
fi

# Restore in batches: pass up to $BATCH generation-qualified URLs per
# `gcloud storage restore` call (avoids the macOS `xargs -I` "command line too
# long" limit), with $PARALLEL batches running concurrently.
echo "Restoring ${COUNT} object(s) — batches of ${BATCH}, ${PARALLEL} parallel ..."
if printf '%s\n' "$LIST" | xargs -n "$BATCH" -P "$PARALLEL" gcloud storage restore; then
  echo "Done. Re-run the dry run to confirm none remain:  $0 ${1:-} ${2:-}"
else
  echo "Some restores failed. Already-restored objects drop off the soft-deleted"
  echo "list, so just re-run this command to retry the remainder until it's clean."
fi
exit 0
