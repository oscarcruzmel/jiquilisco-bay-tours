export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");

    if (url.pathname === "/api/waiver" && request.method === "POST") {
      try {
        const body = await request.json();
        const ref = String(body.ref || "JBT-WAIVER").slice(0, 80);
        const signer = String(body.signer || "Guest").slice(0, 160);
        const email = String(body.email || "").slice(0, 200);
        const record = String(body.record || "").slice(0, 30000);
        if (!record || !signer) return new Response(JSON.stringify({ok:false,error:"Missing waiver data"}), {status:400,headers:{"content-type":"application/json"}});
        if (!env.EMAIL) return new Response(JSON.stringify({ok:false,error:"Email delivery is not configured yet"}), {status:503,headers:{"content-type":"application/json"}});

        await env.EMAIL.send({
          to: "jiquiliscobaytours@gmail.com",
          from: "waivers@jiquiliscobay.com",
          subject: `Signed waiver ${ref} — ${signer}`,
          text: `${record}\n\nCustomer email: ${email || "Not provided"}`,
          replyTo: email || undefined
        });
        return new Response(JSON.stringify({ok:true}), {headers:{"content-type":"application/json","cache-control":"no-store"}});
      } catch (err) {
        return new Response(JSON.stringify({ok:false,error:"Unable to deliver waiver"}), {status:500,headers:{"content-type":"application/json","cache-control":"no-store"}});
      }
    }

    if (url.pathname === "/robots.txt") {
      const file = host === "bahiajiquilisco.com" ? "/robots-es.txt" : "/robots.txt";
      const u = new URL(request.url); u.pathname = file;
      return env.ASSETS.fetch(new Request(u, request));
    }
    if (url.pathname === "/sitemap.xml") {
      const file = host === "bahiajiquilisco.com" ? "/sitemap-es.xml" : "/sitemap.xml";
      const u = new URL(request.url); u.pathname = file;
      return env.ASSETS.fetch(new Request(u, request));
    }
    let assetRequest = request;
    if (host === "bahiajiquilisco.com") {
      const spanish = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/es.html") { spanish.pathname = "/es.html"; assetRequest = new Request(spanish, request); }
      else if (url.pathname === "/blog.html" || url.pathname === "/blog-es.html") { spanish.pathname = "/blog-es.html"; assetRequest = new Request(spanish, request); }
    }
    const response = await env.ASSETS.fetch(assetRequest);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return response;
    let html = await response.text();
    html = html
      .replaceAll("Boat prices below cover up to 6 guests.", "Boat prices below accommodate groups up to 12 guests.")
      .replaceAll("per boat · up to 6 guests", "per boat · up to 12 guests")
      .replaceAll("Los precios de lancha cubren hasta 6 personas.", "Los precios de lancha son para grupos de hasta 12 personas.")
      .replaceAll("por lancha · hasta 6 personas", "por lancha · hasta 12 personas")
      .replaceAll("$100 per ATV · up to 4 hours · 2 riders per ATV", "$35 for 1 hour · $60 for 2 hours · $100 for 4 hours · per ATV · up to 2 riders")
      .replaceAll("$100 por ATV · hasta 4 horas · 2 personas por ATV", "$35 por 1 hora · $60 por 2 horas · $100 por 4 horas · por ATV · hasta 2 personas")
      .replaceAll("30 min $25 · 1 hr $45 · sunset $60 per rider", "30 min $35 · 1 hr $50 · sunset $65 per rider")
      .replaceAll("30 min $25 · 1 hora $45 · atardecer $60 por persona", "30 min $35 · 1 hora $50 · atardecer $65 por persona")
      .replaceAll('data-price="25">30 minutes — $25/rider', 'data-price="35">30 minutes — $35/rider')
      .replaceAll('data-price="45">1 hour — $45/rider', 'data-price="50">1 hour — $50/rider')
      .replaceAll('data-price="60">Sunset 75–90 min — $60/rider', 'data-price="65">Sunset 75–90 min — $65/rider')
      .replaceAll('data-price="25">30 minutos — $25/persona', 'data-price="35">30 minutos — $35/persona')
      .replaceAll('data-price="45">1 hora — $45/persona', 'data-price="50">1 hora — $50/persona')
      .replaceAll('data-price="60">Atardecer 75–90 min — $60/persona', 'data-price="65">Atardecer 75–90 min — $65/persona');
    const isHome = url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/es.html";
    if (isHome) {
      const es = host === "bahiajiquilisco.com";
      const seo = es
        ? '<link rel="alternate" hreflang="es-SV" href="https://bahiajiquilisco.com/"><link rel="alternate" hreflang="en" href="https://jiquiliscobay.com/"><link rel="alternate" hreflang="x-default" href="https://jiquiliscobay.com/">'
        : '<link rel="alternate" hreflang="en" href="https://jiquiliscobay.com/"><link rel="alternate" hreflang="es-SV" href="https://bahiajiquilisco.com/"><link rel="alternate" hreflang="x-default" href="https://jiquiliscobay.com/">';
      const schema = `<script type="application/ld+json">${JSON.stringify({"@context":"https://schema.org","@type":"TouristInformationCenter","name":"Jiquilisco Bay Tours","url":es?"https://bahiajiquilisco.com/":"https://jiquiliscobay.com/","description":es?"Paseos en lancha y experiencias en la Bahía de Jiquilisco, Usulután, El Salvador.":"Boat tours and coastal experiences in Jiquilisco Bay, Usulután, El Salvador.","areaServed":{"@type":"Place","name":"Bahía de Jiquilisco, Usulután, El Salvador"},"sameAs":["https://www.instagram.com/jiquiliscobaytours","https://www.facebook.com/profile.php?id=61590794607731","https://www.tiktok.com/@jiquiliscobaytours"]})}</script>`;
      html = html.replace("</head>", seo + schema + "</head>");
      html = html.replace("</body>", '<script src="/waiver.js" defer></script></body>');
    }
    return new Response(html,{status:response.status,statusText:response.statusText,headers:response.headers});
  }
};