#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
for p in part4_1 part4_2 part4_3 part4_4; do
  OMP_THREAD_LIMIT=1 setsid nohup python3 study/ocr.py "$p" \
    > "study/ocr-$p.log" 2>&1 < /dev/null &
done
