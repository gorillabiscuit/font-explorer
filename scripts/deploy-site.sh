#!/usr/bin/env bash
# Publishes the online build to www.wouterschreuders.com/fonts/.
#
#   npm run build:static                 build it first (into dist-static/)
#   npm run deploy:site -- --dryrun      list what would be uploaded or deleted; changes nothing
#   npm run deploy:site                  ask once, then upload and tell CloudFront to drop its old copies
#   npm run deploy:site -- --yes         the same without asking (where nobody can answer, as in a script)
#
# Needs the AWS CLI, logged in to the account that owns the bucket (set AWS_PROFILE if that is not
# the default profile). Everything it writes or deletes is under s3://www.wouterschreuders.com/fonts/:
# the rest of the site is never touched.
set -euo pipefail

# The AWS CLI shows some answers through a pager (less), which could stop the script until q is pressed.
export AWS_PAGER=""

BUCKET="www.wouterschreuders.com"
# The one folder of the bucket this script may write to. Every destination below is built from DEST.
PREFIX="fonts"
DISTRIBUTION_ID="E2G41RF1T5SZMW"

# Refuse an empty or odd prefix: with PREFIX="" every upload and the --delete below would land on the
# bucket root, which is the portfolio itself.
if [[ ! "$PREFIX" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "deploy-site: PREFIX must be one plain folder name, got '$PREFIX'" >&2
  exit 1
fi
DEST="s3://$BUCKET/$PREFIX"

# --dryrun (or --dry-run) is handed to every s3 command, which then only prints what it would do, and
# the CloudFront steps are skipped. --yes skips the question before a real publish. Anything else is a
# typo, so stop rather than upload by mistake. Each command spells the dry run
# ${DRYRUN[@]+"${DRYRUN[@]}"}: macOS's own bash (3.2) calls an empty array unset under set -u, and this
# form expands to nothing instead.
DRYRUN=()
ASK=1
for arg in "$@"; do
  case "$arg" in
    --dryrun | --dry-run) DRYRUN=(--dryrun) ;;
    --yes) ASK=0 ;;
    *)
      echo "usage: npm run deploy:site [-- --dryrun | -- --yes]" >&2
      exit 2
      ;;
  esac
done
# npm keeps a flag written without the `--` for itself: `npm run deploy:site --dryrun` hands this
# script nothing and sets npm_config_dryrun instead (npm_config_dry_run for --dry-run). Read those too,
# so a dry run asked for either way stays a dry run instead of becoming a real publish.
npm_flag() { [[ -n "${1:-}" && "$1" != "false" ]]; }
if npm_flag "${npm_config_dryrun:-}" || npm_flag "${npm_config_dry_run:-}"; then
  DRYRUN=(--dryrun)
fi

# Work from the project folder, wherever the script is started from.
cd "$(dirname "$0")/.."
DIST="dist-static"

# 0. Publish from a copy of the build, taken now. Every check in this project runs npm run build:static,
#    which empties dist-static/ and fills it again, and this script reads the build for several
#    minutes: a rebuild landing halfway would publish half of one build and half of another, and step 5
#    could delete the scripts the page just published asks for. The copy is one build, checked whole
#    below, and is removed when the script ends, however it ends.
if [[ ! -d "$DIST" ]]; then
  echo "deploy-site: there is no $DIST/. Run npm run build:static first." >&2
  exit 1
fi
# A rebuild starts by emptying dist-static/ and writes catalog.json last. So when the very same
# catalog.json file is there before and after the copy, no build touched the folder while it was
# copied. (stat is spelled differently on macOS and Linux.)
build_stamp() {
  if stat -c '%i' / >/dev/null 2>&1; then stat -c '%i %Y' "$1"; else stat -f '%i %m' "$1"; fi 2>/dev/null || true
}
before=$(build_stamp "$DIST/catalog.json")
if [[ -z "$before" ]]; then
  echo "deploy-site: $DIST/catalog.json is missing. Run npm run build:static first, and let it finish." >&2
  exit 1
fi
SNAP=$(mktemp -d "${TMPDIR:-/tmp}/deploy-site.XXXXXX")
trap 'rm -rf "$SNAP"' EXIT
cp -R "$DIST/." "$SNAP/"
if [[ "$(build_stamp "$DIST/catalog.json")" != "$before" ]]; then
  echo "deploy-site: a build changed $DIST/ while it was being copied. Let it finish, then run npm run deploy:site again." >&2
  exit 1
fi
# Hidden files and folders (a .DS_Store Finder leaves behind) are never published.
find "$SNAP" -mindepth 1 -name '.*' -prune -exec rm -rf {} +

# Only a finished build is published: the page and its catalog must both be there (the export writes
# the catalog last, so a build that stopped halfway has none).
for f in index.html catalog.json; do
  if [[ ! -f "$SNAP/$f" ]]; then
    echo "deploy-site: $DIST/$f is missing. Run npm run build:static first, and let it finish." >&2
    exit 1
  fi
done

# Everything the page and the catalog name must be in the copy. Online, a missing file is not an
# error: CloudFront answers it with the portfolio's own page, so a missing script would leave the font
# page blank, and a missing font file would silently draw another typeface.
missing=0
assets=$(grep -oE "/$PREFIX/assets/[^\"' )>]+" "$SNAP/index.html" | sort -u || true)
if [[ -z "$assets" ]]; then
  echo "deploy-site: $DIST/index.html names no /$PREFIX/assets/ file; was it built with npm run build:static?" >&2
  exit 1
fi
# The scripts load further scripts of their own (fontkit, for one) by a name next to theirs ("./x.js"),
# or, when Vite lists what such a script needs first, by its path from the page ("assets/x.css").
chunks=$(cat "$SNAP"/assets/*.js 2>/dev/null | grep -oE "[\`\"'](\./|assets/)[A-Za-z0-9_.-]+\.(js|css)[\`\"']" |
  sed -E "s#^.(\./|assets/)(.*).\$#/$PREFIX/assets/\2#" | sort -u || true)
assets=$(printf '%s\n%s\n' "$assets" "$chunks" | grep . | sort -u)
fonts=$(grep -oE "/$PREFIX/files/[^\"]+" "$SNAP/catalog.json" | sort -u || true)
while IFS= read -r ref; do
  [[ -n "$ref" ]] || continue
  if [[ ! -f "$SNAP/${ref#/"$PREFIX"/}" ]]; then
    echo "deploy-site: the build names $ref, which is not in $DIST/" >&2
    missing=$((missing + 1))
  fi
done <<<"$assets
$fonts"
if [[ $missing -gt 0 ]]; then
  echo "deploy-site: $missing file(s) missing; a build may have been running. Run npm run build:static again." >&2
  exit 1
fi
# The catalog must be whole (not caught halfway through being written), and online no file may point
# at the local server's /api/ (a GitLab file's original URL, kept in `upstream`, may contain /api/v4/).
if command -v node >/dev/null; then
  node -e 'try { JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")) } catch { process.exit(1) }' "$SNAP/catalog.json" || {
    echo "deploy-site: $DIST/catalog.json is not whole. Run npm run build:static again." >&2
    exit 1
  }
fi
if grep -q '"/api/' "$SNAP/catalog.json"; then
  echo "deploy-site: $DIST/catalog.json still names the local server's /api/; it was not built for the site." >&2
  exit 1
fi
font_count=$(printf '%s\n' "$fonts" | grep -c . || true)
asset_count=$(printf '%s\n' "$assets" | grep -c . || true)

command -v aws >/dev/null || {
  echo "deploy-site: the AWS CLI is not installed (brew install awscli)." >&2
  exit 1
}
# Fails early, before any upload, when the CLI is not logged in. Only reads who is logged in.
who=$(aws sts get-caller-identity --query Arn --output text)
echo "AWS identity: $who"
echo "Build checked: the page, its $asset_count script and style file(s), and the $font_count font file(s) the catalog names are all there."

# A real publish asks first, so a slip (a flag npm swallowed, say) never publishes by accident. Where
# there is no terminal to answer, it needs --yes.
if [[ ${#DRYRUN[@]} -eq 0 && $ASK -eq 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "deploy-site: this would publish for real, and there is no terminal to ask. Run npm run deploy:site -- --yes to publish, or -- --dryrun to only look." >&2
    exit 1
  fi
  answer=""
  read -r -p "Publish to $DEST/ (https://www.wouterschreuders.com/$PREFIX/) as $who? [y/N] " answer || true
  if [[ "$answer" != "y" && "$answer" != "Y" && "$answer" != "yes" ]]; then
    echo "Nothing published."
    exit 1
  fi
fi

# 1. Font files. Named by a hash of their original URL, so a name never changes its content and
#    --size-only skips the ones already up there (a rebuild rewrites every local copy, which would
#    otherwise look newer). One pass per extension, so each gets its own Content-Type. Nothing is
#    deleted: a visitor whose page is still the previous one may ask for an older file.
if [[ -d "$SNAP/files" ]]; then
  for pair in woff2:font/woff2 woff:font/woff ttf:font/ttf otf:font/otf; do
    ext="${pair%%:*}"
    type="${pair#*:}"
    aws s3 sync "$SNAP/files/" "$DEST/files/" ${DRYRUN[@]+"${DRYRUN[@]}"} --size-only \
      --exclude "*" --include "*.$ext" \
      --content-type "$type" \
      --cache-control "public, max-age=2592000"
  done
fi

# 2. The page's scripts and styles. Vite puts a content hash in each name, so they can be cached for
#    a year. The previous build's files stay for now (step 5 removes them), so a visitor who still
#    has the old page can finish loading it.
aws s3 sync "$SNAP/assets/" "$DEST/assets/" ${DRYRUN[@]+"${DRYRUN[@]}"} --size-only \
  --cache-control "public, max-age=31536000, immutable"

# 3. Anything else the build put at the top (nothing today; a favicon later, say), for an hour.
aws s3 sync "$SNAP/" "$DEST/" ${DRYRUN[@]+"${DRYRUN[@]}"} \
  --exclude "files/*" --exclude "assets/*" --exclude "index.html" --exclude "catalog.json" \
  --cache-control "public, max-age=3600"

# 4. The catalog, then the page last: the page names this build's assets, so it only goes up once
#    everything it points at is there. The page is revalidated on every visit; the catalog after
#    five minutes. Both go up uncompressed: CloudFront compresses on the way out (checked on
#    2026-10-02: it sent /fonts/ gzipped and the portfolio's scripts as br), so the 1 MB catalog
#    reaches a visitor as about 140 KB.
aws s3 cp "$SNAP/catalog.json" "$DEST/catalog.json" ${DRYRUN[@]+"${DRYRUN[@]}"} \
  --content-type "application/json" \
  --cache-control "public, max-age=300"
aws s3 cp "$SNAP/index.html" "$DEST/index.html" ${DRYRUN[@]+"${DRYRUN[@]}"} \
  --content-type "text/html; charset=utf-8" \
  --cache-control "no-cache"

if [[ ${#DRYRUN[@]} -eq 0 ]]; then
  # CloudFront keeps copies at its edges; drop the old page and catalog there, and wait until it has,
  # so no edge is still handing out a page that names the assets step 5 removes.
  invalidation=$(aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" \
    --paths "/fonts" "/fonts/*" --query Invalidation.Id --output text)
  echo "CloudFront invalidation $invalidation started; waiting for it to finish (a minute or two)…"
  # If the wait gives up (after ten minutes), the script stops here: the site is already live, and the
  # old assets simply stay until the next deploy removes them.
  aws cloudfront wait invalidation-completed --distribution-id "$DISTRIBUTION_ID" --id "$invalidation"
else
  echo "(dry run: CloudFront invalidation skipped)"
fi

# 5. Now that every edge serves the new page, remove assets no build needs any more. --delete only
#    ever acts inside fonts/assets/, and compares against the same copy the page came from.
aws s3 sync "$SNAP/assets/" "$DEST/assets/" ${DRYRUN[@]+"${DRYRUN[@]}"} --size-only --delete \
  --cache-control "public, max-age=31536000, immutable"

if [[ ${#DRYRUN[@]} -eq 0 ]]; then
  echo "Done: https://www.wouterschreuders.com/$PREFIX/"
else
  echo "Dry run done: nothing was uploaded, deleted or invalidated."
fi
