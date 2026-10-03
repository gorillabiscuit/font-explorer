#!/bin/bash
cd /tmp/fx_work
for q in fast pixel calm loud black; do
  node run_claude.mjs shuf claude-haiku-4-5-20251001 shuf-$q-haiku "" q-$q.txt
  node run_claude.mjs shuf claude-sonnet-5-5 shuf-$q-sonnetlow low q-$q.txt
done
