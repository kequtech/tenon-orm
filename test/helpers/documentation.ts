import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = heading[1]!
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\p{L}\p{N}_\s-]/gu, '')
      .replace(/\s/g, '-');
    let anchor = base;
    for (let suffix = 1; anchors.has(anchor); suffix++) anchor = `${base}-${suffix}`;
    anchors.add(anchor);
  }
  return anchors;
}

/** Check navigability in the actual installed artifact, including retired-page/anchor mistakes. */
export async function checkDocumentationLinks(
  root: string,
  paths: readonly string[],
): Promise<void> {
  const files = new Set(paths);
  const anchors = new Map<string, Set<string>>();
  for (const path of paths.filter((path) => path.endsWith('.md'))) {
    const markdown = await readFile(join(root, path), 'utf8');
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = match[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [file, fragment] = target.split('#');
      const relative = file
        ? posix.normalize(posix.join(posix.dirname(path), decodeURIComponent(file)))
        : path;
      assert.ok(files.has(relative), `${path} links to missing package file ${target}`);
      if (!fragment) continue;
      if (!anchors.has(relative))
        anchors.set(relative, headingAnchors(await readFile(join(root, relative), 'utf8')));
      assert.ok(
        anchors.get(relative)!.has(decodeURIComponent(fragment)),
        `${path} links to missing heading ${target}`,
      );
    }
  }
}
