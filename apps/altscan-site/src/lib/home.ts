// The homepage is a prerendered asset, so it needs the worker (wrangler.jsonc run_worker_first) for
// two things the asset layer cannot do: answer `Accept: text/markdown` with a Markdown representation
// of the page, and send RFC 8288 Link headers that point agents at the machine-readable resources.

type Assets = { fetch(request: Request): Promise<Response> };

/** Absolute paths, so the header reads the same from any URL the worker answers. */
export const HOME_LINK = [
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</llms.txt>; rel="describedby"; type="text/plain"',
  '</sitemap-index.xml>; rel="sitemap"; type="application/xml"',
].join(', ');

/** The Markdown representation of `/`: llms.txt already is one (llmstxt.org), so it is the single source. */
export const HOME_MARKDOWN = '/llms.txt';

/**
 * True when `text/markdown` outranks `text/html` in an Accept header (or HTML is absent). Browsers send
 * text/html and stay on HTML; a bare `Accept: text/markdown` opts in. Same rule as the explorers' middleware.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let mdQ = -1;
  let htmlQ = -1;
  for (const raw of accept.split(',')) {
    const [type, ...params] = raw.split(';').map((s) => s.trim().toLowerCase());
    if (!type) continue;
    let q = 1;
    for (const p of params) {
      if (p.startsWith('q=')) {
        const v = parseFloat(p.slice(2));
        if (!Number.isNaN(v)) q = v;
      }
    }
    if (type === 'text/markdown') mdQ = Math.max(mdQ, q);
    else if (type === 'text/html') htmlQ = Math.max(htmlQ, q);
  }
  return mdQ > 0 && mdQ > htmlQ;
}

export async function homeResponse(request: Request, assets: Assets): Promise<Response> {
  const markdown = prefersMarkdown(request.headers.get('accept'));
  const asset = await assets.fetch(markdown ? new Request(new URL(HOME_MARKDOWN, request.url), request) : request);
  const res = new Response(asset.body, asset);
  if (markdown && asset.ok) res.headers.set('content-type', 'text/markdown; charset=utf-8');
  // One URL, two representations: shared caches must key on Accept.
  res.headers.append('vary', 'Accept');
  res.headers.set('link', HOME_LINK);
  return res;
}
