import type { Source } from '../../shared/types.js';
import { useUnit } from '../unit-context.js';
import { BlockView } from './BlockView.js';
import { ThreadView } from './ThreadView.js';

function isMarkdownSource(source: Source): boolean {
  return source.kind === 'reply' || source.language === 'md' || source.language === 'markdown';
}

export function SourceView({ source }: { source: Source }) {
  const { unit, imageUrl } = useUnit();
  const blockIds = new Set(source.blocks.map((b) => b.id));
  // Top-level threads whose block no longer exists still need a home.
  const orphans = unit.threads.filter(
    (t) => t.parentThreadId === null && t.anchor.sourceId === source.id && !blockIds.has(t.anchor.blockId),
  );
  const markdown = isMarkdownSource(source);

  return (
    <div className={`source ${markdown ? 'source-markdown' : 'source-code'}`}>
      {source.kind === 'file' && (
        <div className="source-path" title={source.path}>
          {source.path}
        </div>
      )}
      {source.detectedBy === 'git' && (
        <div className="note">
          This file is not in the agent's edit records; it was found by comparing this turn's git status. The agent may have written it with a shell command, or you or another program changed it during the turn.
        </div>
      )}
      {source.detectedBy === 'mtime' && (
        <div className="note">
          Possibly from this turn: the file was modified during the turn, but the folder has no git, so only its modification time could be checked. You or another program may have changed it.
        </div>
      )}
      {source.error && <div className="note error">Could not read the file: {source.error}</div>}
      {source.truncated && <div className="note">The file is larger than 1 MB; only the first 1 MB is shown.</div>}
      {source.image && source.path && !source.error ? (
        <figure className="image-source">
          <img src={imageUrl(source.id, source.path)} alt={source.path} />
        </figure>
      ) : source.binary ? (
        <div className="note">Binary file; the content is not shown.</div>
      ) : (
        source.blocks.map((b) => (
          <BlockView
            key={b.id}
            block={b}
            sourceId={source.id}
            mode={markdown ? 'markdown' : 'code'}
            lang={source.language}
          />
        ))
      )}
      {!source.error && !source.binary && !source.image && source.blocks.length === 0 && (
        <p className="note">(empty)</p>
      )}
      {orphans.length > 0 && (
        <div className="orphans">
          <h3>Other threads</h3>
          {orphans.map((t) => (
            <ThreadView key={t.id} thread={t} />
          ))}
        </div>
      )}
    </div>
  );
}
