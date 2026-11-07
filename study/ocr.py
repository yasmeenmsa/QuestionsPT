#!/usr/bin/env python3
"""Render each PDF page and OCR its two columns separately."""
import csv
import io
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
ATT = ROOT.parent / ".hoplite" / "attachments"
OUT = ROOT / "ocr"
TMP = Path("/tmp/ocr_pages")

PARTS = [
    ("part4_1", ATT / "art_upload_e2375647c85048399b558a7f0517e8d3" / "part4_1_pages_1-72.pdf", 1),
    ("part4_2", ATT / "art_upload_6f4e813247354112bfd8d7cb402450b4" / "part4_2_pages_73-144.pdf", 73),
    ("part4_3", ATT / "art_upload_ab6ee7594c134153b3ff7c1dfb08be34" / "part4_3_pages_145-216.pdf", 145),
    ("part4_4", ATT / "art_upload_e4875eac152d4159b1a05dbe58959b3e" / "part4_4_pages_217-288.pdf", 217),
]


def ocr(img_path: Path) -> str:
    r = subprocess.run(
        ["tesseract", str(img_path), "stdout", "-l", "eng", "--psm", "6", "tsv"],
        capture_output=True, text=True,
    )
    rows = csv.DictReader(io.StringIO(r.stdout), delimiter="\t",
                          quoting=csv.QUOTE_NONE)
    lines, order = {}, []
    for row in rows:
        if row.get("level") != "5":
            continue
        tok = (row.get("text") or "").strip()
        if not tok:
            continue
        try:
            conf = float(row["conf"])
        except (TypeError, ValueError):
            conf = 0.0
        if conf < 50:
            continue
        if re.fullmatch(r"[^A-Za-z0-9]+", tok):
            continue
        key = (int(row["block_num"]), int(row["par_num"]), int(row["line_num"]))
        if key not in lines:
            lines[key] = []
            order.append(key)
        lines[key].append(tok)
    out, prev_par = [], None
    for key in order:
        toks = lines[key]
        if len(toks) > 3 and len(toks[-1]) == 1 and toks[-1].isalpha():
            toks = toks[:-1]
        if prev_par is not None and key[1] != prev_par:
            out.append("")
        out.append(" ".join(toks))
        prev_par = key[1]
    return "\n".join(out)


def find_gutter(im: Image.Image) -> int:
    """Return the x of the widest blank vertical band near the page centre."""
    w, h = im.size
    gray = im.convert("L")
    # Downsample rows for speed; count dark pixels per column.
    small = gray.resize((w, max(1, h // 8)))
    px = small.load()
    sw, sh = small.size
    ink = [0] * sw
    for x in range(sw):
        c = 0
        for y in range(sh):
            if px[x, y] < 160:
                c += 1
        ink[x] = c
    lo, hi = int(w * 0.40), int(w * 0.60)
    best_x, best_run, run_start = w // 2, 0, None
    for x in range(lo, hi):
        if ink[x] == 0:
            if run_start is None:
                run_start = x
            run = x - run_start + 1
            if run > best_run:
                best_run = run
                best_x = run_start + run // 2
        else:
            run_start = None
    return best_x


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for name, pdf, start in PARTS:
        if only and name != only:
            continue
        dest = OUT / name
        dest.mkdir(exist_ok=True)
        for i in range(72):
            page_no = i + 1
            global_no = start + i
            txt_path = dest / f"page-{global_no:03d}.txt"
            if txt_path.exists() and txt_path.stat().st_size > 0:
                continue
            png = TMP / f"{name}-{page_no:03d}.png"
            if not png.exists():
                subprocess.run(
                    ["pdftoppm", "-f", str(page_no), "-l", str(page_no),
                     "-r", "200", "-png", "-singlefile", str(pdf),
                     str(png.with_suffix(""))],
                    check=True,
                )
            im = Image.open(png)
            w, h = im.size
            split = find_gutter(im)
            left = im.crop((0, 0, split + 8, h))
            right = im.crop((split - 8, 0, w, h))
            lp = TMP / f"{name}-{page_no:03d}-L.png"
            rp = TMP / f"{name}-{page_no:03d}-R.png"
            left.save(lp)
            right.save(rp)
            text = (
                f"=== PAGE {global_no} LEFT ===\n" + ocr(lp) +
                f"\n=== PAGE {global_no} RIGHT ===\n" + ocr(rp)
            )
            txt_path.write_text(text, encoding="utf-8")
            print(f"done {name} page {global_no}", flush=True)


if __name__ == "__main__":
    main()
