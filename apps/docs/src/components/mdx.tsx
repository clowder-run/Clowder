import defaultMdxComponents from 'fumadocs-ui/mdx';
import { DocsBody } from 'fumadocs-ui/layouts/docs/page';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import { ImageZoom } from 'fumadocs-ui/components/image-zoom';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import type { ComponentProps } from 'react';
import type { MDXComponents } from 'mdx/types';

// Uncloud's logo in one colour: the "UC" is cut out of the rounded square.
const uncloudIcon =
  '<svg viewBox="0 0 80 80"><path fill="currentColor" fill-rule="evenodd" d="M16 0h48a16 16 0 0 1 16 16v48a16 16 0 0 1-16 16H16A16 16 0 0 1 0 64V16A16 16 0 0 1 16 0Zm-3.5 27.5h7v18h11v-18h7v25h-25Zm55 0v7h-18v11h18v7h-25v-25Z"/></svg>';
const keyIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>';

// Fumadocs picks the icon from the language, these files get theirs from the title.
function fileIcon(title?: string) {
  if (!title) return;
  if (/compose(\.[\w-]+)?\.ya?ml$/.test(title)) return uncloudIcon;
  if (/^\.env/.test(title)) return keyIcon;
}

function CodeBlockPre(props: ComponentProps<'pre'> & { icon?: string }) {
  return (
    <CodeBlock {...props} icon={fileIcon(props.title) ?? props.icon}>
      <Pre>{props.children}</Pre>
    </CodeBlock>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    pre: CodeBlockPre,
    ImageZoom,
    TypeTable,
    ...components,
  } satisfies MDXComponents;
}

// for the Fumadocs integration, `wrapper` gives the content its prose styles
export default getMDXComponents({ wrapper: DocsBody });
