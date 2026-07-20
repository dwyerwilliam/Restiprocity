import React from 'react';

export function SourcePreview({ text }: { text: string }) {
  return <pre className="response-source-preview text-xs font-mono leading-5 whitespace-pre-wrap break-all" data-testid="response-source-preview">{text}</pre>;
}
