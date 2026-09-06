export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");

    if (host === "bahiajiquilisco.com") {
      const spanish = new URL(request.url);

      if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/es.html") {
        spanish.pathname = "/es.html";
        return env.ASSETS.fetch(new Request(spanish, request));
      }

      if (url.pathname === "/blog.html" || url.pathname === "/blog-es.html") {
        spanish.pathname = "/blog-es.html";
        return env.ASSETS.fetch(new Request(spanish, request));
      }
    }

    return env.ASSETS.fetch(request);
  }
};
