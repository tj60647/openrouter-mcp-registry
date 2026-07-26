'use client';

import { useEffect, useId, useState } from 'react';

interface MermaidDiagramProps {
  chart: string;
  title: string;
}

export default function MermaidDiagram({ chart, title }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const diagramId = useId().replace(/:/g, '-');

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      try {
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default;

        // 'base' is the only built-in theme that fully honours themeVariables.
        // Palette mirrors the studio's hand-drawn flow SVG (App.tsx:684-775):
        // white fills, #1f1f1f strokes, Inter labels, no chromatic accent.
        mermaid.initialize({
          startOnLoad: false,
          theme: 'base',
          securityLevel: 'loose',
          themeVariables: {
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
            primaryColor: '#ffffff',
            primaryTextColor: '#000000',
            primaryBorderColor: '#000000',
            secondaryColor: '#f8f8f8',
            tertiaryColor: '#f8f8f8',
            lineColor: '#1f1f1f',
            textColor: '#000000',
            nodeTextColor: '#000000',
            nodeBorder: '#1f1f1f',
            background: '#ffffff',
            mainBkg: '#ffffff',
            secondBkg: '#f8f8f8',
            tertiaryBkg: '#f8f8f8',
            clusterBkg: '#ffffff',
            clusterBorder: '#e0e0e0',
            edgeLabelBackground: '#ffffff',
            titleColor: '#000000',
          },
        });

        const { svg: renderedSvg } = await mermaid.render(`mermaid-${diagramId}`, chart);
        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (renderError) {
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : 'Failed to render diagram');
        }
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [chart, diagramId]);

  if (error) {
    return <div className="error-msg">Unable to render {title}: {error}</div>;
  }

  if (!svg) {
    return <div className="loading">Rendering {title}...</div>;
  }

  return (
    <div
      aria-label={title}
      className="mermaid-diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
      role="img"
    />
  );
}