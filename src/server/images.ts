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

/** Where a source's image references come from and what relative paths resolve against. */
interface ImageScope {
  refs: string[];
  baseDir: string;
}

/**
 * The image scope of one source of a unit: the reply, a file ('<fileId>') or an
 * answer ('msg:<messageId>'). Null when the source does not exist.
 */
function imageScope(unit: ReviewUnit, sourceId: string, requested: string): ImageScope | null {
  if (sourceId === unit.reply.id) return { refs: markdownImageRefs(unit.reply.content), baseDir: unit.cwd };
  if (sourceId.startsWith('msg:')) {
    const messageId = sourceId.slice('msg:'.length);
    for (const t of unit.threads) {
      const m = t.messages.find((x) => x.id === messageId && x.role === 'assistant');
      if (m) return { refs: markdownImageRefs(m.content), baseDir: unit.cwd };
    }
    return null;
  }
  const file = unit.files.find((f) => f.id === sourceId);
  if (!file?.path) return null;
  // An image file shows itself; its path is relative to the unit cwd.
  if (file.image && requested === file.path) return { refs: [file.path], baseDir: unit.cwd };
  if (!isMarkdownFile(file.language)) return null;
  // A Markdown file's relative images resolve against the file's own directory.
  return { refs: markdownImageRefs(file.content), baseDir: path.dirname(path.resolve(unit.cwd, file.path)) };
}

export interface ResolvedImage {
  file: string;
  contentType: string;
}

/**
 * Resolve an image requested for one source of a unit, or null when it must not be
 * served: the source does not reference it, it is not a local path, it is not an
 * image extension, it points at a network share, or the file does not exist.
 */
export function resolveUnitImage(unit: ReviewUnit, sourceId: string, requested: string): ResolvedImage | null {
  if (!sourceId || !requested || !isLocalImagePath(requested)) return null;
  const contentType = IMAGE_CONTENT_TYPES[imageExtension(requested)];
  if (!contentType) return null;
  const scope = imageScope(unit, sourceId, requested);
  if (!scope || !scope.refs.includes(requested)) return null;
  const candidates = [requested];
  try {
    const decoded = decodeURI(requested);
    if (decoded !== requested) candidates.push(decoded);
  } catch {
    /* keep the literal path only */
  }
  for (const c of candidates) {
    const file = path.resolve(scope.baseDir, c);
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
