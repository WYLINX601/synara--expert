import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function resolveSkillResourceLink(
  href: string,
  currentPath: string,
  paths: readonly string[],
): string | null {
  let value: string;
  try {
    value = decodeURIComponent(href.split(/[?#]/u)[0] ?? "");
  } catch {
    return null;
  }
  if (!value || /^[a-z][a-z\d+.-]*:/iu.test(value) || value.startsWith("/") || value.includes("\\"))
    return null;
  const parts = currentPath.split("/").slice(0, -1);
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  const resolved = parts.join("/");
  return paths.includes(resolved) ? resolved : null;
}

/** Static package preview: no raw HTML, executable blocks or automatic remote images. */
export function SkillMarkdownPreview({
  text,
  currentPath,
  paths,
  onOpenResource,
}: {
  text: string;
  currentPath: string;
  paths: readonly string[];
  onOpenResource: (path: string) => void;
}) {
  const body = text.replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
  return (
    <article
      aria-label="Markdown 预览"
      className="min-w-0 space-y-4 break-words text-ui leading-relaxed [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_h1]:text-ui-xl [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:text-ui-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_pre]:text-ui-sm [&_table]:block [&_table]:overflow-auto [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-1 [&_code]:break-words"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            const resource = href ? resolveSkillResourceLink(href, currentPath, paths) : null;
            if (resource)
              return (
                <button
                  type="button"
                  className="inline cursor-pointer text-primary underline underline-offset-2"
                  onClick={() => onOpenResource(resource)}
                >
                  {children}
                </button>
              );
            if (href && /^https?:\/\//iu.test(href))
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  {children}
                </a>
              );
            return <span>{children}</span>;
          },
          img: ({ src, alt }) => {
            const resource =
              typeof src === "string" ? resolveSkillResourceLink(src, currentPath, paths) : null;
            return resource ? (
              <button
                type="button"
                className="text-primary underline"
                onClick={() => onOpenResource(resource)}
              >
                图片：{alt || resource}
              </button>
            ) : (
              <span className="text-muted-foreground">图片：{alt || "外部图片"}</span>
            );
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </article>
  );
}
