import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function ResultMarkdown({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        // Model output must not load remote images or tracking pixels.
        img: ({ alt }) => <span>{alt}</span>,
      }}
    >
      {text}
    </Markdown>
  );
}
