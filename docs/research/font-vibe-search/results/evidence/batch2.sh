#!/bin/bash
cd /tmp/fx_work
for q in pixel calm loud black; do
  node run_claude.mjs tags claude-haiku-4-5-20251001 q-$q-haiku-tags "" q-$q.txt
  node run_claude.mjs nogoogletags claude-haiku-4-5-20251001 q-$q-haiku-hidden "" q-$q.txt
  node run_claude.mjs tags claude-sonnet-5-5 q-$q-sonnetlow-tags low q-$q.txt
  node run_claude.mjs nogoogletags claude-sonnet-5-5 q-$q-sonnetlow-hidden low q-$q.txt
done
