#!/usr/bin/env python3
"""Re-OCR pages at 400 dpi to recover options/answers missed at 200 dpi."""
import json
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
ATT = ROOT.parent / ".hoplite" / "attachments"
PARTS = {
    "part4_1": ATT / "art_upload_e2375647c85048399b558a7f0517e8d3" / "part4_1_pages_1-72.pdf",
    "part4_2": ATT / "art_upload_6f4e813247354112bfd8d7cb402450b4" / "part4_2_pages_73-144.pdf",
    "part4_3": ATT / "art_upload_ab6ee7594c134153b3ff7c1dfb08be34" / "part4_3_pages_145-216.pdf",
    "part4_4": ATT / "art_upload_e4875eac152d4159b1a05dbe58959b3e" / "part4_4_pages_217-288.pdf",
}
HEADER = re.compile(r"PTEXAM\s+([A-Z]+)\s*:\s*QUESTION\s*(\d*)", re.I)
ANSWER = re.compile(r"Correct\s*Answer\s*:?\s*([1-4])", re.I)


def ocr(path):
    r = subprocess.run(
        ["tesseract", str(path), "-", "-l", "eng", "--psm", "6"],
        capture_output=True, text=True,
    )
    return r.stdout


def locate(exam, num):
    for f in sorted((ROOT / "ocr").glob("part4_*/*.txt")):
        text = f.read_text(encoding="utf-8")
        for m in HEADER.finditer(text):
            if m.group(1).upper() == exam and m.group(2) == str(num):
                page = int(f.stem.split("-")[1])
                side = "LEFT" if text.rfind("LEFT", 0, m.start()) > text.rfind("RIGHT", 0, m.start()) else "RIGHT"
                return f.parent.name, page, side
    return None


def main():
    data = json.loads((ROOT / "questions.json").read_text(encoding="utf-8"))
    bad = [q for q in data if len(q["options"]) < 4 or q["correct"] is None]
    out = {}
    for q in bad:
        loc = locate(q["exam"], q["number"])
        if not loc:
            print("NOT FOUND", q["exam"], q["number"])
            continue
        part, page, side = loc
        png = Path(f"/tmp/rec_{part}_{page}.png")
        if not png.exists():
            subprocess.run(
                ["pdftoppm", "-f", str(page - {"part4_1": 0, "part4_2": 72,
                 "part4_3": 144, "part4_4": 216}[part]), "-l",
                 str(page - {"part4_1": 0, "part4_2": 72, "part4_3": 144,
                 "part4_4": 216}[part]), "-r", "400", "-png", "-singlefile",
                 str(PARTS[part]), str(png.with_suffix(""))],
                check=True,
            )
        im = Image.open(png)
        w, h = im.size
        crop = im.crop((0, 0, w // 2, h)) if side == "LEFT" else im.crop((w // 2, 0, w, h))
        cp = Path(f"/tmp/rec_{part}_{page}_{side}.png")
        crop.save(cp)
        text = ocr(cp)
        # isolate this question's segment
        ms = list(HEADER.finditer(text))
        seg = text
        for i, m in enumerate(ms):
            if m.group(1).upper() == q["exam"] and m.group(2) == str(q["number"]):
                end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
                seg = text[m.end():end]
                break
        ans = ANSWER.search(seg)
        opts = {}
        for line in seg.splitlines():
            mm = re.match(r"^\s*([1-4])[.)]?\s+(.*)$", line)
            if mm and mm.group(1) not in opts:
                opts[mm.group(1)] = mm.group(2).strip()
        out[f"{q['exam']}-{q['number']}"] = {
            "answer": int(ans.group(1)) if ans else None,
            "options": opts,
        }
        print(q["exam"], q["number"], "ans", out[f"{q['exam']}-{q['number']}"]["answer"],
              "opts", opts)
    (ROOT / "recovered.json").write_text(json.dumps(out, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
