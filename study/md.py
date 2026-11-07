#!/usr/bin/env python3
"""Render parsed questions into Markdown study files."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "md"

EXAM_TITLES = {
    "ONE": "PT Exam One",
    "TWO": "PT Exam Two",
    "THREE": "PT Exam Three",
    "FOUR": "PT Exam Four",
}

MISSING = {"TWO": [82], "THREE": [180]}

FOOTER = re.compile(
    r"^\s*(?:System|Content Outline|Content|Level\s*\d|SCOREBUILDERS|Exam\s*T)\b.*$",
    re.I,
)


def reflow(text: str) -> str:
    """Join OCR line breaks into readable paragraphs."""
    text = "\n".join(ln for ln in text.splitlines() if not FOOTER.match(ln))
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    paras, cur = [], ""
    for ln in lines:
        if re.match(r"^\d+\.\s", ln):
            if cur:
                paras.append(cur)
            cur = ln
            continue
        if not cur:
            cur = ln
        elif len(cur) > 250 and re.search(r"[.!?]$", cur):
            paras.append(cur)
            cur = ln
        else:
            cur = f"{cur} {ln}"
    if cur:
        paras.append(cur)
    return "\n\n".join(paras)


def render(q) -> str:
    lines = [f"### Question {q['number']}", ""]
    stem = clean_stem(reflow(q["stem"]), q["options"])
    if stem:
        lines += [stem, ""]
    for k in ("1", "2", "3", "4"):
        if k in q["options"]:
            lines.append(f"{k}. {q['options'][k]}")
    lines.append("")
    if q["correct"]:
        lines.append(f"**Correct answer: {q['correct']}**")
        lines.append("")
    expl = clean_expl(reflow(q["explanation"]))
    if expl:
        lines += ["**Explanation**", "", expl, ""]
    return "\n".join(lines)


def clean_expl(text: str) -> str:
    """Remove page-footer artifacts that OCR merged into explanations."""
    text = re.sub(r"\s*(?:e\s+)?SCOREBUILDERS.*$", "", text, flags=re.S | re.I)
    text = re.sub(r"\s*[‘']?System:.*$", "", text, flags=re.S)
    text = re.sub(r"\s*Content Outline:.*$", "", text, flags=re.S)
    text = re.sub(r"\s*\d*\s*Unit 3 Examinations Answer.*$", "", text, flags=re.S | re.I)
    text = re.sub(r"\s*Level\s*\d.*$", "", text, flags=re.S | re.I)
    text = re.sub(r"\s*(?:e\s+)*Intelligent Insights.*$", "", text, flags=re.S | re.I)
    text = re.sub(r"\s*(?:fil\s+)?Pro Tip:.*$", "", text, flags=re.S | re.I)
    text = re.sub(r"\s*PHYSICAL THERAPY EXAM.*$", "", text, flags=re.S | re.I)
    text = re.sub(r"\s*Exam (?:One|Two|Three) O Answer Key.*$", "", text, flags=re.S | re.I)
    return text.strip()


def clean_stem(stem: str, options: dict) -> str:
    """Drop option fragments that leaked into the stem during OCR."""
    stem = re.sub(r"(?:\s*\b[1-4][.)]\s*[^\n]{0,25})+$", "", stem).strip()
    for text in options.values():
        words = text.split()
        for n in range(len(words), 2, -1):
            frag = " ".join(words[-n:])
            if len(frag) >= 15 and frag in stem:
                stem = stem[: stem.index(frag)].rstrip(" ,;:-")
                break
    return stem


def main():
    data = json.loads((ROOT / "questions.json").read_text(encoding="utf-8"))
    overrides = json.loads((ROOT / "overrides.json").read_text(encoding="utf-8"))
    for q in data:
        ov = overrides.get(f"{q['exam']}-{q['number']}")
        if ov:
            if "options" in ov:
                q["options"] = ov["options"]
            if "correct" in ov:
                q["correct"] = ov["correct"]
            if "explanation" in ov:
                q["explanation"] = ov["explanation"]
    OUT.mkdir(exist_ok=True)
    by_exam = {}
    for q in data:
        by_exam.setdefault(q["exam"], []).append(q)

    index = ["# NPTE Practice Questions — Answer Key", ""]
    index.append(
        "All questions from the four supplied PDFs (288 scanned pages), "
        "converted to Markdown with options, correct answers, and explanations."
    )
    index.append("")
    index.append(f"Recovered questions: **{len(data)}** of 540.")
    index.append("")
    index.append("| Exam | Questions | File |")
    index.append("| --- | --- | --- |")

    for exam in sorted(by_exam):
        qs = sorted(by_exam[exam], key=lambda q: q["number"])
        title = EXAM_TITLES.get(exam, f"PT Exam {exam}")
        fname = f"{title.replace(' ', '-').lower()}.md"
        n_missing = len(MISSING.get(exam, []))
        note = f" ({n_missing} not present in the source PDF)" if n_missing else ""
        body = [f"# {title}", "", f"{len(qs) + n_missing} questions{note}.", ""]
        missing = set(MISSING.get(exam, []))
        for n in range(1, 181):
            if n in missing:
                body.append(f"### Question {n}\n\n"
                            "_Not present in the supplied PDF (page missing or "
                            "duplicated in the source scan)._\n")
                continue
            q = next((x for x in qs if x["number"] == n), None)
            if q:
                body.append(render(q))
        (OUT / fname).write_text("\n".join(body), encoding="utf-8")
        index.append(f"| {title} | {len(qs)} | [{fname}]({fname}) |")

    index += [
        "",
        "## Notes",
        "",
        "- Two questions are absent from the supplied scans: **PT Exam Two Q82** "
        "(a duplicated page replaced it) and **PT Exam Three Q180** (the last "
        "page ends at Q179).",
        "- Text was recovered by OCR from scanned images, so a few words may be "
        "imperfect. Questions that refer to a video or image keep that wording; "
        "the media itself is not in the PDFs.",
        "",
        "## Two-day study plan",
        "",
        "| Day | Focus |",
        "| --- | --- |",
        "| Day 1 morning | PT Exam One, Q1–90 |",
        "| Day 1 afternoon | PT Exam One, Q91–180 |",
        "| Day 1 evening | PT Exam Two, Q1–90 |",
        "| Day 2 morning | PT Exam Two, Q91–180 |",
        "| Day 2 afternoon | PT Exam Three, Q1–90 |",
        "| Day 2 evening | PT Exam Three, Q91–180 + review missed answers |",
        "",
        "Read the stem, answer from memory, then check the answer and "
        "explanation. Mark every miss and re-read only those explanations.",
    ]
    (OUT / "README.md").write_text("\n".join(index) + "\n", encoding="utf-8")
    print("wrote", len(by_exam), "exam files,", len(data), "questions")


if __name__ == "__main__":
    main()
