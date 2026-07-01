// Cloudflare Pages Function (middleware) for /join/<gameID>.
//
// Renders route-specific INITIAL HTML: it bakes this game's id into the Smart App Banner's app-argument
// and the "Open the game" button, server-side, so the deep link lands in the first byte of HTML with no
// reliance on client-side JavaScript. The rest of the page (design, copy, OG card) comes straight from the
// static invite.html template, so there is no markup to duplicate or let drift.
//
// Intent is preserved: /join/<id> always carries <id>, and it never emits a Daily deep link. If anything is
// off (no id, a non-HTML response), it passes the underlying response through untouched, so /join never breaks.

const APP_ID = "6780044797";

export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);

  // Only rewrite the invite deep-link pages: /join/<id> (single path segment, optional trailing slash).
  const match = url.pathname.match(/^\/join\/([^\/]+)\/?$/);

  // The underlying page: _redirects rewrites /join/* to the static invite.html template.
  let response = await next();
  let type = response.headers.get("content-type") || "";
  if (!response.ok || !type.includes("text/html")) {
    // Fall back to fetching the template directly in case the rewrite didn't resolve under next().
    response = await env.ASSETS.fetch(new URL("/invite", url.origin));
    type = response.headers.get("content-type") || "";
  }
  if (!match || !type.includes("text/html")) return response;

  const gameID = match[1];
  const joinURL = `${url.origin}/join/${gameID}`; // the canonical https universal link for this game
  const appURL = `jotto://join/${gameID}`; // custom-scheme fallback for a browser that won't fire it

  return new HTMLRewriter()
    .on('meta[name="apple-itunes-app"]', {
      element(el) {
        el.setAttribute("content", `app-id=${APP_ID}, app-argument=${joinURL}`);
      },
    })
    .on("a#openapp", {
      element(el) {
        el.setAttribute("href", appURL);
      },
    })
    .transform(response);
}
