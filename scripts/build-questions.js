import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const sources = [
  { file: "pt-exam-one.md", exam: "PTEXAM ONE", slug: "one", expected: 180 },
  { file: "pt-exam-two.md", exam: "PTEXAM TWO", slug: "two", expected: 179 },
  { file: "pt-exam-three.md", exam: "PTEXAM THREE", slug: "three", expected: 179 }
];

function clean(lines) {
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

function parseNumberedLines(lines) {
  const before = [];
  const items = ["", "", "", ""];
  let current = -1;
  for (const line of lines) {
    const normalizedLine = line.replace(/^[‘’“”]\s*([1-4]\.)/, "$1");
    const match = normalizedLine.match(/^([1-4])\.\s+(.*)$/);
    if (match) {
      current = Number(match[1]) - 1;
      items[current] = match[2].trim();
    } else if (current >= 0) {
      if (normalizedLine.trim()) items[current] += ` ${normalizedLine.trim()}`;
    } else {
      before.push(line);
    }
  }
  const remaining = before.filter((line) => line.trim());
  if (!items[0] && items.slice(1).every(Boolean) && remaining.length) {
    items[0] = remaining.pop().trim();
  }
  return { before: clean(remaining), items: items.map((item) => item.replace(/\s+/g, " ").trim()) };
}

const questions = [];
const errors = [];

for (const source of sources) {
  const markdown = readFileSync(join(root, "questions", source.file), "utf8");
  const parts = markdown.split(/^### Question (\d+)\s*$/m);
  let count = 0;

  for (let index = 1; index < parts.length; index += 2) {
    const number = Number(parts[index]);
    const body = parts[index + 1];
    if (body.includes("_Not present in the supplied PDF")) continue;
    const answerMatch = body.match(/\*\*Correct answer:\s*([1-4])\*\*/i);
    if (!answerMatch || answerMatch.index === undefined) {
      errors.push(`${source.exam} Q${number}: missing correct answer`);
      continue;
    }

    const questionPart = body.slice(0, answerMatch.index);
    const explanationPart = body.slice(answerMatch.index + answerMatch[0].length)
      .replace(/^\s*\*\*Explanation\*\*\s*/i, "");
    const parsedQuestion = parseNumberedLines(questionPart.trim().split("\n"));
    const parsedExplanation = parseNumberedLines(explanationPart.trim().split("\n"));

    if (parsedQuestion.items.some((item) => !item)) {
      errors.push(`${source.exam} Q${number}: missing one or more options`);
      continue;
    }
    if (parsedExplanation.items.some((item) => !item)) {
      errors.push(`${source.exam} Q${number}: missing one or more rationales`);
      continue;
    }

    questions.push({
      id: `ptexam-${source.slug}-q${number}`,
      number,
      exam: source.exam,
      chapter: "Full Answer Key",
      stem: parsedQuestion.before,
      image: source.slug === "one" && number === 11 ? "./images/q11-weight-shift.jpg" : null,
      options: parsedQuestion.items,
      correctAnswer: Number(answerMatch[1]),
      citation: "",
      overview: parsedExplanation.before,
      rationales: parsedExplanation.items,
      system: "NPTE Practice Examination",
      contentOutline: "Examination and Interventions",
      level: "Level 2",
      oneLineFact: ""
    });
    count++;
  }

  if (count !== source.expected) {
    errors.push(`${source.exam}: expected ${source.expected} questions, parsed ${count}`);
  }
}

if (errors.length) throw new Error(errors.join("\n"));

const normalized = questions.map((question, index) => ({
  ...question,
  block: Math.min(4, Math.floor(index / 140) + 1)
}));

writeFileSync(join(root, "data", "questions.json"), JSON.stringify(normalized, null, 2) + "\n", "utf8");
console.log(`Built ${normalized.length} questions across ${sources.length} exams.`);
