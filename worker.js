export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");

    let assetRequest = request;

    if (host === "bahiajiquilisco.com") {
      const spanish = new URL(request.url);

      if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/es.html") {
        spanish.pathname = "/es.html";
        assetRequest = new Request(spanish, request);
      } else if (url.pathname === "/blog.html" || url.pathname === "/blog-es.html") {
        spanish.pathname = "/blog-es.html";
        assetRequest = new Request(spanish, request);
      }
    }

    const response = await env.ASSETS.fetch(assetRequest);
    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/html")) {
      return response;
    }

    let html = await response.text();
    html = html
      .replaceAll("Boat prices below cover up to 6 guests.", "Boat prices below accommodate groups up to 12 guests.")
      .replaceAll("per boat · up to 6 guests", "per boat · up to 12 guests")
      .replaceAll("Los precios de lancha cubren hasta 6 personas.", "Los precios de lancha son para grupos de hasta 12 personas.")
      .replaceAll("por lancha · hasta 6 personas", "por lancha · hasta 12 personas");

    return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }
};
