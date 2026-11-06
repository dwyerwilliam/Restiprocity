import React, { forwardRef, useCallback, useLayoutEffect, useRef } from 'react';

export interface RequestUrlFieldProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'> {
  minLines?: number;
  maxLines?: number;
}

/**
 * The request URL is one persistent native control. It grows with wrapped
 * content up to a small readable limit, then scrolls internally. Keeping the
 * same textarea mounted means selection, clipboard, undo, and autocomplete
 * state are never split across compact/expanded controls.
 */
export const RequestUrlField = forwardRef<HTMLTextAreaElement, RequestUrlFieldProps>(function RequestUrlField({
  minLines = 1,
  maxLines = 5,
  className,
  style,
  value,
  ...props
}, forwardedRef) {
  const localRef = useRef<HTMLTextAreaElement>(null);

  const setRef = useCallback((element: HTMLTextAreaElement | null) => {
    localRef.current = element;
    if (typeof forwardedRef === 'function') {
      forwardedRef(element);
    } else if (forwardedRef) {
      forwardedRef.current = element;
    }
  }, [forwardedRef]);

  const resize = useCallback(() => {
    const element = localRef.current;
    if (!element) return;

    const computed = window.getComputedStyle(element);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
    const padding = (Number.parseFloat(computed.paddingTop) || 0) + (Number.parseFloat(computed.paddingBottom) || 0);
    const border = (Number.parseFloat(computed.borderTopWidth) || 0) + (Number.parseFloat(computed.borderBottomWidth) || 0);
    const minHeight = lineHeight * minLines + padding + border;
    const maxHeight = lineHeight * maxLines + padding + border;

    element.style.height = 'auto';
    const contentHeight = Math.max(element.scrollHeight, minHeight);
    const height = Math.min(contentHeight, maxHeight);
    element.style.height = `${height}px`;
    element.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  }, [maxLines, minLines]);

  useLayoutEffect(() => {
    resize();
  }, [resize, value]);

  useLayoutEffect(() => {
    const element = localRef.current;
    const parent = element?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [resize]);

  return (
    <textarea
      {...props}
      ref={setRef}
      rows={1}
      value={value}
      className={[
        'w-full min-w-0 resize-none overflow-x-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 font-mono text-sm leading-5 text-[var(--color-text)] caret-[var(--color-primary)]',
        className,
      ].filter(Boolean).join(' ')}
      style={{ overflowWrap: 'anywhere', ...style }}
    />
  );
});
