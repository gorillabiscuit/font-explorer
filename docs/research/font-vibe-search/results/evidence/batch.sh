# NOTE: this first batch of 16 runs reused the 'fast movement' prompt (run_claude.mjs did not yet read argv[6]); the outputs were relabelled fast-*-r2..r5 and used as replicates. batch2.sh is the correct four-query batch.
#!/bin/bash
cd /tmp/fx_work
for q in pixel calm loud black; do
  node run_claude.mjs tags claude-haiku-4-5-20251001 h-tags-$q "" q-$q.txt
  node run_claude.mjs nogoogletags claude-haiku-4-5-20251001 h-hid-$q "" q-$q.txt
  node run_claude.mjs tags claude-sonnet-5-5 s-tags-$q low q-$q.txt
  node run_claude.mjs nogoogletags claude-sonnet-5-5 s-hid-$q low q-$q.txt
done
