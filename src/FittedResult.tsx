import { useLayoutEffect, useRef } from 'react';
import { ResultMarkdown } from './ResultMarkdown';

/** Fit the complete result to its available space; never discard model output. */
export function FittedResult({
  text,
  streaming,
  allowColumns = true,
}: {
  text: string;
  streaming: boolean;
  allowColumns?: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = frame.current;
    const body = content.current;
    if (!box || !body) return;
    let disposed = false;
    const fit = () => {
      if (disposed || !box.clientHeight || !box.clientWidth) return;
      body.style.fontSize = '';
      body.style.columnCount = '1';
      const maximum = parseFloat(getComputedStyle(body).fontSize);
      let low = 0.25;
      let high = maximum;
      const fits = () =>
        body.scrollHeight <= box.clientHeight && body.scrollWidth <= box.clientWidth;
      if (fits()) return;
      // Find the largest font that fits, including rendered Markdown spacing.
      for (let i = 0; i < 12; i++) {
        const size = (low + high) / 2;
        body.style.fontSize = `${size}px`;
        if (fits()) low = size;
        else high = size;
      }
      body.style.fontSize = `${low}px`;
      // Long lists/paragraphs can use a second column instead of wasting width
      // while shrinking every line. Keep ordinary answers in one reading column.
      if (allowColumns && low < 14 && box.clientWidth >= 400) {
        const singleColumnSize = low;
        body.style.columnCount = '2';
        low = 0.25;
        high = maximum;
        for (let i = 0; i < 12; i++) {
          const size = (low + high) / 2;
          body.style.fontSize = `${size}px`;
          if (fits()) low = size;
          else high = size;
        }
        if (low <= singleColumnSize) {
          body.style.columnCount = '1';
          low = singleColumnSize;
        }
        body.style.fontSize = `${low}px`;
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    void document.fonts.ready.then(fit);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [text, streaming, allowColumns]);
  return (
    <div ref={frame} className="fitted-result">
      <div ref={content} className="answer-text markdown-result">
        <ResultMarkdown text={text} />
        {streaming && <span className="stream-cursor" />}
      </div>
    </div>
  );
}
