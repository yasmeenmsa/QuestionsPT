#!/usr/bin/env python3
"""Parse OCR column text into structured question records."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OCR = ROOT / "ocr"

HEADER = re.compile(r"PTEXAM\s+([A-Z]+)\s*:\s*QUESTION\s*(\d*)", re.I)
ANSWER = re.compile(r"Correct\s*Answer\s*:?\s*([1-4])", re.I)
ANSWER_ANY = re.compile(r"Correct\s*Answer", re.I)
OPTION = re.compile(r"^\s*([1-4])[.)]\s+(.*)$")


def blocks():
    files = sorted(OCR.glob("part4_*/*.txt"), key=lambda p: int(p.stem.split("-")[1]))
    for f in files:
        text = f.read_text(encoding="utf-8")
        parts = re.split(r"=== PAGE (\d+) (LEFT|RIGHT) ===", text)
        # parts: ['', page, side, body, page, side, body, ...]
        for i in range(1, len(parts), 3):
            yield int(parts[i]), parts[i + 1], parts[i + 2]


def clean(s):
    s = s.replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')
    drop = re.compile(
        r"^\s*(?:\d+\s*)?(?:Unit\s+\d+\s*\|?\s*Examinations?\s*Answer\s*Ke\w*"
        r"|Section\s+(?:One|Two|Three|Four)\s*[-–]\s*Questions.*"
        r"|\d{1,3}\s*/\s*\d{1,3})\s*$",
        re.I,
    )
    s = "\n".join(ln for ln in s.splitlines() if not drop.match(ln))
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def parse_segment(exam, num, body):
    lines = body.splitlines()
    ans_idx = next((i for i, l in enumerate(lines) if ANSWER_ANY.search(l)), None)
    if ans_idx is not None:
        head = lines[:ans_idx]
        explanation = lines[ans_idx + 1:]
    else:
        # No answer line survived OCR: explanation starts after the option-4 block.
        start = next((i for i, l in enumerate(lines)
                      if re.match(r"^\s*1[.)]?\s+\S", l)), 0)
        idx4 = next((i for i in range(start, len(lines))
                     if re.match(r"^\s*4[.)]?\s+\S", lines[i])), None)
        if idx4 is not None:
            j = idx4 + 1
            while j < len(lines) and lines[j].strip():
                j += 1
            head, explanation = lines[:j], lines[j:]
        else:
            head, explanation = lines, []

    opt_start = next(
        (i for i, l in enumerate(head) if re.match(r"^\s*1[.)]?\s+\S", l)), None
    )
    stem_lines = head[:opt_start] if opt_start is not None else head
    opt_lines = head[opt_start:] if opt_start is not None else []

    options, cur = {}, None
    for line in opt_lines:
        m = re.match(r"^\s*([1-4])[.)]?\s+(.*)$", line)
        if m and (cur is None or int(m.group(1)) == int(cur) + 1):
            cur = m.group(1)
            options[cur] = m.group(2).strip()
        elif cur is not None:
            options[cur] = (options[cur] + " " + line.strip()).strip()

    # A one/two-character option body is usually a split word; drop it.
    for k, v in list(options.items()):
        if len(v) <= 2 and v.isalpha():
            options[k] = ""
        else:
            # "P Prone press-up" -> "Prone press-up"
            options[k] = re.sub(r"^([A-Za-z]) (?=\1)", "", v)
    options = {k: v for k, v in options.items() if v}
    return {
        "exam": exam,
        "number": int(num),
        "stem": clean("\n".join(stem_lines)),
        "options": {k: clean(v) for k, v in sorted(options.items())},
        "explanation": clean("\n".join(explanation)),
    }


def infer_answer(rec):
    """When the answer digit is lost, the correct option's explanation item
    is the one missing its leading number."""
    if rec["correct"] is not None:
        return rec["correct"]
    expl = rec["explanation"]
    present = set()
    for m in re.finditer(r"(?m)^\s*([1-4])[.)]\s", expl):
        present.add(m.group(1))
    missing = [n for n in ("1", "2", "3", "4") if n not in present]
    if len(missing) == 1:
        return int(missing[0])
    return None


def main():
    records = []
    current = None
    last_num = {}
    for page, side, body in blocks():
        matches = list(HEADER.finditer(body))
        if not matches:
            if current:
                current["explanation"] = clean(
                    current["explanation"] + "\n" + body
                )
            continue
        # text before first header belongs to previous question
        pre = body[: matches[0].start()]
        if current and pre.strip():
            current["explanation"] = clean(current["explanation"] + "\n" + pre)
        for idx, m in enumerate(matches):
            end = matches[idx + 1].start() if idx + 1 < len(matches) else len(body)
            seg = body[m.end():end]
            exam = m.group(1).upper()
            num = m.group(2)
            if not num:
                num = str(last_num.get(exam, 0) + 1)
            last_num[exam] = int(num)
            rec = parse_segment(exam, num, seg)
            ans = ANSWER.search(seg)
            rec["correct"] = int(ans.group(1)) if ans else None
            rec["correct"] = infer_answer(rec)
            rec["page"] = page
            records.append(rec)
            current = rec

    # dedupe by (exam, number), keep the one with most content
    best = {}
    for r in records:
        key = (r["exam"], r["number"])
        score = len(r["stem"]) + len(r["explanation"]) + 10 * len(r["options"])
        if key not in best or score > best[key][0]:
            best[key] = (score, r)
    final = [v[1] for v in best.values()]
    final.sort(key=lambda r: (r["exam"], r["number"]))
    (ROOT / "questions.json").write_text(
        json.dumps(final, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"records: {len(final)}")
    from collections import Counter
    print(Counter(r["exam"] for r in final))
    missing = [r for r in final if not r["options"] or r["correct"] is None]
    print(f"incomplete: {len(missing)}")
    for r in missing[:10]:
        print(" ", r["exam"], r["number"], "opts", len(r["options"]), "ans", r["correct"])


if __name__ == "__main__":
    main()
