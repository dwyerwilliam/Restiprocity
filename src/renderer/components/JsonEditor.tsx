import { useEffect, useRef } from 'react';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { Annotation, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const jsonHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--color-json-key)' },
  { tag: tags.string, color: 'var(--color-json-value)' },
  { tag: tags.number, color: 'var(--color-json-number)' },
  { tag: tags.bool, color: 'var(--color-json-boolean)' },
  { tag: tags.null, color: 'var(--color-json-null)' },
  { tag: tags.punctuation, color: 'var(--color-json-structural)' },
]);

const jsonTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--color-text)',
    backgroundColor: 'var(--color-bg)',
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  },
  '.cm-content': {
    minHeight: '12rem',
    padding: '8px 12px',
    caretColor: 'var(--color-text)',
  },
  '.cm-editor': { height: '100%' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-gutters': {
    color: 'var(--color-text-muted)',
    backgroundColor: 'var(--color-surface)',
    borderRight: '1px solid var(--color-border)',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--color-surface-hover)' },
  '&.cm-focused': { outline: '1px solid var(--color-primary)' },
  '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--color-surface-active)' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--color-error)' },
  '.cm-lintRange-error': { backgroundImage: 'none', borderBottom: '2px wavy var(--color-error)' },
}, { dark: true });

export interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
}

const externalValueUpdate = Annotation.define<boolean>();

export function JsonEditor({ value, onChange }: JsonEditorProps) {
  const editorParentRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const parent = editorParentRef.current;
    if (!parent || editorViewRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          json(),
          syntaxHighlighting(jsonHighlightStyle),
          linter(jsonParseLinter(), { delay: 300 }),
          lintGutter(),
          jsonTheme,
          EditorView.updateListener.of(update => {
            if (
              update.docChanged &&
              !update.transactions.some(transaction => transaction.annotation(externalValueUpdate))
            ) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
      parent,
    });
    editorViewRef.current = view;

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view || view.state.doc.toString() === value) return;

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: externalValueUpdate.of(true),
    });
  }, [value]);

  return (
    <div data-testid="request-json-editor" className="request-json-editor flex h-full min-h-0 w-full overflow-hidden rounded border border-[var(--color-border)]">
      <div ref={editorParentRef} className="h-full min-h-0 w-full" data-testid="request-json-editor-diagnostic" aria-label="JSON editor diagnostics" />
    </div>
  );
}
