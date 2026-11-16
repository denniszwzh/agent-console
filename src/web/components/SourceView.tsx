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
          agent 的編輯紀錄裡沒有這個檔案，是比對這一輪的 git 狀態找到的：可能是 agent 用 shell 指令寫的，也可能是你或其他程式在這段期間改的。
        </div>
      )}
      {source.detectedBy === 'mtime' && (
        <div className="note">
          可能由這一輪產生：這個檔案在這一輪期間被修改過，但資料夾沒有 git，只能依修改時間判斷，也可能是你或其他程式改的。
        </div>
      )}
      {source.error && <div className="note error">無法讀取檔案：{source.error}</div>}
      {source.truncated && <div className="note">檔案超過 1 MB，只顯示前 1 MB 的內容。</div>}
      {source.image && source.path && !source.error ? (
        <figure className="image-source">
          <img src={imageUrl(source.id, source.path)} alt={source.path} />
        </figure>
      ) : source.binary ? (
        <div className="note">二進位檔，不顯示內容。</div>
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
        <p className="note">（沒有內容）</p>
      )}
      {orphans.length > 0 && (
        <div className="orphans">
          <h3>其他問題串</h3>
          {orphans.map((t) => (
            <ThreadView key={t.id} thread={t} />
          ))}
        </div>
      )}
    </div>
  );
}
