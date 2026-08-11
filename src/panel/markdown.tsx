/**
 * A very small Markdown renderer that emits React nodes.
 *
 * It renders to elements rather than HTML strings on purpose: model output never
 * reaches `dangerouslySetInnerHTML`, so there is no injection surface to reason
 * about. It covers the subset the interviewer actually produces - paragraphs,
 * headings, lists, fenced code, inline code, bold and italic - and renders
 * anything else as plain text.
 */

import type { JSX, ReactNode } from 'react';

const FENCE_SOURCE = '```([\\w+-]*)\\n?([\\s\\S]*?)```';
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  for (const part of text.split(INLINE)) {
    if (part === '') continue;
    const key = `${keyPrefix}-${index++}`;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      nodes.push(<code key={key}>{part.slice(1, -1)}</code>);
    } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      nodes.push(<strong key={key}>{part.slice(2, -2)}</strong>);
    } else if (
      ((part.startsWith('*') && part.endsWith('*')) ||
        (part.startsWith('_') && part.endsWith('_'))) &&
      part.length > 2
    ) {
      nodes.push(<em key={key}>{part.slice(1, -1)}</em>);
    } else {
      nodes.push(part);
    }
  }
  return nodes;
}

const LIST_ITEM = /^\s*(?:[-*]|\d+\.)\s+(.*)$/;
const HEADING = /^(#{1,4})\s+(.*)$/;

function renderProse(source: string, keyPrefix: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  const paragraphs = source.split(/\n{2,}/);

  paragraphs.forEach((block, blockIndex) => {
    const trimmed = block.trim();
    if (trimmed === '') return;
    const key = `${keyPrefix}-b${blockIndex}`;
    const lines = trimmed.split('\n');

    if (lines.every((line) => LIST_ITEM.test(line))) {
      blocks.push(
        <ul key={key}>
          {lines.map((line, i) => (
            <li key={`${key}-${i}`}>
              {renderInline(LIST_ITEM.exec(line)?.[1] ?? line, `${key}-${i}`)}
            </li>
          ))}
        </ul>,
      );
      return;
    }

    const heading = HEADING.exec(lines[0] ?? '');
    if (heading && lines.length === 1) {
      const level = Math.min(heading[1]!.length + 2, 6);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={key}>{renderInline(heading[2] ?? '', key)}</Tag>);
      return;
    }

    blocks.push(
      <p key={key}>
        {lines.flatMap((line, i) => {
          const rendered = renderInline(line, `${key}-${i}`);
          return i === 0 ? rendered : [<br key={`${key}-br${i}`} />, ...rendered];
        })}
      </p>,
    );
  });

  return blocks;
}

export function Markdown({ source }: { source: string }): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  // A fresh regex per render: `lastIndex` is per-instance state, and a shared
  // module-level one would make rendering order-dependent.
  const fence = new RegExp(FENCE_SOURCE, 'g');
  for (let match = fence.exec(source); match !== null; match = fence.exec(source)) {
    nodes.push(...renderProse(source.slice(cursor, match.index), `p${index}`));
    nodes.push(
      <pre key={`code-${index}`} data-language={match[1] || 'text'}>
        <code>{match[2]?.replace(/\n$/, '') ?? ''}</code>
      </pre>,
    );
    cursor = match.index + match[0].length;
    index += 1;
  }

  // An unterminated fence means the block is still streaming; render what we have.
  const rest = source.slice(cursor);
  const openFence = rest.lastIndexOf('```');
  if (openFence !== -1) {
    nodes.push(...renderProse(rest.slice(0, openFence), `p${index}`));
    const body = rest.slice(openFence + 3);
    const newline = body.indexOf('\n');
    nodes.push(
      <pre
        key={`code-open-${index}`}
        data-language={newline === -1 ? 'text' : body.slice(0, newline) || 'text'}
      >
        <code>{newline === -1 ? '' : body.slice(newline + 1)}</code>
      </pre>,
    );
  } else {
    nodes.push(...renderProse(rest, `p${index}`));
  }

  return <>{nodes}</>;
}
