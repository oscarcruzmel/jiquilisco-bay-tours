export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");

    // The Spanish domain always opens on the Spanish homepage at its root.
    if (host === "bahiajiquilisco.com" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const spanish = new URL(request.url);
      spanish.pathname = "/es.html";
      return env.ASSETS.fetch(new Request(spanish, request));
    }

    return env.ASSETS.fetch(request);
  }
};
