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

        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'loose',
          themeVariables: {
            primaryColor: '#1a1a1a',
            primaryTextColor: '#e0e0e0',
            primaryBorderColor: '#6366f1',
            lineColor: '#818cf8',
            tertiaryColor: '#111111',
            background: '#111111',
            mainBkg: '#1a1a1a',
            secondBkg: '#151515',
            tertiaryBkg: '#0f0f0f',
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