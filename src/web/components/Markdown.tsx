import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isLocalImagePath } from '../../shared/images.js';
import { svgDataUrl } from '../svg.js';
import { CodeBlock } from './CodeBlock.js';
import { Mermaid } from './Mermaid.js';

interface Props {
  content: string;
  /** Maps a local image path to a URL on this server; without it local images are not shown. */
  imageUrl?: (path: string) => string;
}

/**
 * Keeps each image's original Markdown URL (before URL normalisation) on the
 * element as data-raw-src, so the image endpoint gets exactly the path the text references.
 */
function remarkRawImageSrc() {
  return (tree: any) => {
    const definitions = new Map<string, string>();
    const refs: any[] = [];
    const walk = (node: any) => {
      if (node.type === 'definition') definitions.set(String(node.identifier).toLowerCase(), node.url);
      if (node.type === 'image') setRawSrc(node, node.url);
      if (node.type === 'imageReference') refs.push(node);
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk(tree);
    for (const node of refs) {
      const url = definitions.get(String(node.identifier).toLowerCase());
      if (url) setRawSrc(node, url);
    }
  };
}

function setRawSrc(node: any, url: string) {
  node.data ??= {};
  node.data.hProperties = { ...(node.data.hProperties ?? {}), dataRawSrc: url };
}

function hastText(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  return Array.isArray(node.children) ? node.children.map(hastText).join('') : '';
}

function codeLanguage(code: any): string | undefined {
  const classes: unknown = code?.properties?.className;
  if (!Array.isArray(classes)) return undefined;
  const cls = classes.find((c) => typeof c === 'string' && c.startsWith('language-')) as string | undefined;
  return cls?.slice('language-'.length);
}

// Image src is never taken from the Markdown directly: the img renderer decides.
const urlTransform = (url: string, key: string, node: { tagName: string }) =>
  node.tagName === 'img' && key === 'src' ? null : defaultUrlTransform(url);

export function Markdown({ content, imageUrl }: Props) {
  const components: Components = {
    pre({ node }) {
      const code = node?.children?.[0] as any;
      if (!code || code.type !== 'element' || code.tagName !== 'code') return <pre>{hastText(node)}</pre>;
      const text = hastText(code).replace(/\n$/, '');
      const lang = codeLanguage(code);
      if (lang === 'mermaid') return <Mermaid code={text} />;
      if (lang === 'svg') {
        return (
          <figure className="svg-figure">
            <img src={svgDataUrl(text)} alt="SVG 圖片" />
          </figure>
        );
      }
      return <CodeBlock code={text} lang={lang} />;
    },
    img({ node, alt }) {
      const raw = (node?.properties as Record<string, unknown> | undefined)?.dataRawSrc;
      if (typeof raw === 'string' && imageUrl && isLocalImagePath(raw)) {
        return <img src={imageUrl(raw)} alt={alt ?? ''} loading="lazy" />;
      }
      return (
        <span className="img-blocked" title="外部圖片不會載入">
          [圖片：{alt || '未命名'}]
        </span>
      );
    },
    a({ href, children }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
  };
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkRawImageSrc]} urlTransform={urlTransform} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
