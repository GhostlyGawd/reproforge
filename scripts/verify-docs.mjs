import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const excludedDirectories = new Set([
  ".git",
  ".next",
  "node_modules",
  "playwright-report",
  "test-results",
]);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const pathname = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(pathname)));
    else if (entry.isFile()) files.push(pathname);
  }
  return files;
}

function localTarget(rawTarget) {
  const target = rawTarget.replace(/^<|>$/g, "");
  if (
    target.length === 0 ||
    target.startsWith("#") ||
    /^(?:data|https?|mailto):/i.test(target)
  ) {
    return null;
  }
  const pathOnly = target.split("#", 1)[0]?.split("?", 1)[0] ?? "";
  return decodeURIComponent(pathOnly);
}

const files = await filesUnder(root);
const markdownFiles = files.filter((pathname) => extname(pathname) === ".md");
const failures = [];
let localLinkCount = 0;

for (const markdownFile of markdownFiles) {
  const markdown = await readFile(markdownFile, "utf8");
  const links = markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g);
  for (const match of links) {
    const target = localTarget(match[1] ?? "");
    if (target === null || target.length === 0) continue;
    localLinkCount += 1;
    const resolved = isAbsolute(target)
      ? resolve(root, `.${target}`)
      : resolve(dirname(markdownFile), target);
    if (!resolved.startsWith(root)) {
      failures.push(
        `${relative(root, markdownFile)} escapes the repository: ${target}`,
      );
      continue;
    }
    try {
      await stat(resolved);
    } catch {
      failures.push(
        `${relative(root, markdownFile)} has a missing target: ${target}`,
      );
    }
  }
}

const evidenceRoot = join(root, "docs", "evidence");
const evidenceJson = (await filesUnder(evidenceRoot)).filter(
  (pathname) => extname(pathname) === ".json",
);
for (const pathname of evidenceJson) {
  try {
    JSON.parse(await readFile(pathname, "utf8"));
  } catch (error) {
    failures.push(
      `${relative(root, pathname)} is invalid JSON: ${
        error instanceof Error ? error.message : "unknown parse failure"
      }`,
    );
  }
}

if (failures.length > 0) {
  console.error(failures.sort().join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Verified ${localLinkCount} local Markdown links and ${evidenceJson.length} evidence JSON files.`,
  );
}
