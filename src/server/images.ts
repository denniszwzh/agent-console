import fs from 'node:fs';
import path from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { IMAGE_CONTENT_TYPES, imageExtension, isLocalImagePath } from '../shared/images.js';
import type { ReviewUnit } from '../shared/types.js';

/** URLs used with image syntax (inline or by reference) in a Markdown document. */
export function markdownImageRefs(content: string): string[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(content);
  const refs: string[] = [];
  const definitions = new Map<string, string>();
  const imageRefIds: string[] = [];
  const walk = (node: any) => {
    if (node.type === 'image' && typeof node.url === 'string') refs.push(node.url);
    if (node.type === 'imageReference') imageRefIds.push(String(node.identifier).toLowerCase());
    if (node.type === 'definition') definitions.set(String(node.identifier).toLowerCase(), node.url);
    if (Array.isArray(node.children)) for (const c of node.children) walk(c);
  };
  walk(tree);
  for (const id of imageRefIds) {
    const url = definitions.get(id);
    if (url) refs.push(url);
  }
  return refs;
}

function isMarkdownFile(language: string | undefined): boolean {
  return language === 'md' || language === 'markdown';
}

/** Image paths a unit may serve: its image files plus local images referenced from its Markdown. */
export function allowedImagePaths(unit: ReviewUnit): Set<string> {
  const allowed = new Set<string>();
  for (const f of unit.files) if (f.image && f.path) allowed.add(f.path);
  const docs = [unit.reply.content];
  for (const f of unit.files) if (isMarkdownFile(f.language)) docs.push(f.content);
  for (const t of unit.threads) for (const m of t.messages) if (m.role === 'assistant') docs.push(m.content);
  for (const doc of docs) for (const ref of markdownImageRefs(doc)) allowed.add(ref);
  return allowed;
}

export interface ResolvedImage {
  file: string;
  contentType: string;
}

/**
 * Resolve a requested image path for a unit, or null when it must not be served:
 * not referenced by the unit, not a local path, not an image extension, or a UNC target.
 */
export function resolveUnitImage(unit: ReviewUnit, requested: string): ResolvedImage | null {
  if (!requested || !isLocalImagePath(requested)) return null;
  if (!allowedImagePaths(unit).has(requested)) return null;
  const contentType = IMAGE_CONTENT_TYPES[imageExtension(requested)];
  if (!contentType) return null;
  const candidates = [requested];
  try {
    const decoded = decodeURI(requested);
    if (decoded !== requested) candidates.push(decoded);
  } catch {
    /* keep the literal path only */
  }
  for (const c of candidates) {
    const file = path.resolve(unit.cwd, c);
    // Never touch network shares or device paths (e.g. \\host\share, \\?\...).
    if (file.startsWith('\\\\') || file.startsWith('//')) return null;
    try {
      if (fs.statSync(file).isFile()) return { file, contentType };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
