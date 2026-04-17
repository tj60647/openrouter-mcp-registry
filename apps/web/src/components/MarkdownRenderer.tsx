'use client';

import React from 'react';

// ── Inline parser ─────────────────────────────────────────────────────────────

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Matches: `code`, **bold**, __bold__, *italic*, _italic_, [label](url)
  const pattern =
    /(`[^`\n]+`|\*\*[\s\S]+?\*\*|__[\s\S]+?__|(?<!\*)\*(?!\*)[\s\S]+?(?<!\*)\*(?!\*)|(?<!_)_(?!_)[\s\S]+?(?<!_)_(?!_)|\[[^\]]+\]\([^)]+\))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(...splitNewlines(text.slice(lastIndex, match.index), `t-${lastIndex}`));
    }

    const m = match[0];
    const key = `i-${match.index}`;

    if (m.startsWith('`')) {
      nodes.push(<code key={key}>{m.slice(1, -1)}</code>);
    } else if (m.startsWith('**') || m.startsWith('__')) {
      nodes.push(<strong key={key}>{renderInline(m.slice(2, -2))}</strong>);
    } else if (m.startsWith('*') || m.startsWith('_')) {
      nodes.push(<em key={key}>{renderInline(m.slice(1, -1))}</em>);
    } else if (m.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(m);
      if (linkMatch) {
        nodes.push(
          <a key={key} href={linkMatch[2]} target="_blank" rel="noopener noreferrer">
            {linkMatch[1]}
          </a>
        );
      } else {
        nodes.push(m);
      }
    }

    lastIndex = match.index + m.length;
  }

  if (lastIndex < text.length) {
    nodes.push(...splitNewlines(text.slice(lastIndex), `t-${lastIndex}`));
  }

  return nodes;
}

function splitNewlines(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split('\n');
  const nodes: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    if (i > 0) nodes.push(<br key={`${keyPrefix}-br-${i}`} />);
    if (part) nodes.push(part);
  });
  return nodes;
}

// ── Block parser ──────────────────────────────────────────────────────────────

function parseBlocks(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      nodes.push(
        <pre key={`code-${i}`}>
          <code className={lang ? `language-${lang}` : ''}>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
      nodes.push(<hr key={`hr-${i}`} />);
      i++;
      continue;
    }

    // Header
    const headerMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const content = headerMatch[2];
      const headingNodes = renderInline(content);
      if (level === 1) nodes.push(<h1 key={`h-${i}`}>{headingNodes}</h1>);
      else if (level === 2) nodes.push(<h2 key={`h-${i}`}>{headingNodes}</h2>);
      else if (level === 3) nodes.push(<h3 key={`h-${i}`}>{headingNodes}</h3>);
      else nodes.push(<h4 key={`h-${i}`}>{headingNodes}</h4>);
      i++;
      continue;
    }

    // Unordered list
    if (/^[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s+/, ''));
        i++;
      }
      nodes.push(
        <ul key={`ul-${i}`}>
          {items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+[.)]\s+/, ''));
        i++;
      }
      nodes.push(
        <ol key={`ol-${i}`}>
          {items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Blank line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph — collect until blank line or block-level element
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^[-*+]\s/.test(lines[i]) &&
      !/^\d+[.)]\s/.test(lines[i]) &&
      !/^(-{3,}|_{3,}|\*{3,})$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      nodes.push(<p key={`p-${i}`}>{renderInline(paraLines.join('\n'))}</p>);
    }
  }

  return nodes;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  content: string;
  className?: string;
}

export default function MarkdownRenderer({ content, className }: Props) {
  const nodes = parseBlocks(content);
  return <div className={`md-body${className ? ` ${className}` : ''}`}>{nodes}</div>;
}
