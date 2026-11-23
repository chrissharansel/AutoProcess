import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Renders chat Markdown (bold, headings, lists, tables, inline code, code blocks). Raw HTML is never rendered. */
export default function Markdown({ children }: { children: string }) {
  return <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{children}</ReactMarkdown></div>;
}
