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
        await env.EMAIL.send({to:"jiquiliscobaytours@gmail.com",from:"waivers@jiquiliscobay.com",subject:`Signed waiver ${ref} — ${signer}`,text:`${record}\n\nCustomer email: ${email || "Not provided"}`,replyTo:email || undefined});
        return new Response(JSON.stringify({ok:true}), {headers:{"content-type":"application/json","cache-control":"no-store"}});
      } catch (err) {
        return new Response(JSON.stringify({ok:false,error:"Unable to deliver waiver"}), {status:500,headers:{"content-type":"application/json","cache-control":"no-store"}});
      }
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const body = await request.json();
        const message = String(body.message || "").trim().slice(0, 500);
        const lang = body.lang === "es" ? "es" : "en";
        if (!message) return Response.json({answer: lang === "es" ? "Escribe una pregunta para ayudarte." : "Please enter a question."}, {status:400});
        if (!env.AI) return Response.json({answer: lang === "es" ? "El asistente no está disponible en este momento. Escríbenos por WhatsApp." : "The assistant is unavailable right now. Please message us on WhatsApp."}, {status:503});
        const facts = `Jiquilisco Bay Tours operates in Jiquilisco Bay, Usulután, El Salvador.
Boat tours: 3-hour Bay Explorer $150 per private boat; 5-hour Mangrove & Beach Tour $225; Full-Day Adventure 7–8 hours $350; Sunset Boat Tour 2 hours $150. Boat groups may be up to 12 guests.
Deposits after availability confirmation: $50 for 3-hour and sunset; $75 for 5-hour; full-day/add-on-only deposit is confirmed with booking. Never tell a guest a date is available; availability must be confirmed by the human team before payment.
ATV at Punta San Juan del Gozo: $35/ATV 1 hour, $60/ATV 2 hours, $100/ATV 4 hours; up to 2 riders per ATV; inventory/availability must be confirmed.
Horseback riding per rider: 30 min $35, 1 hour $50, sunset 75–90 min $65; availability confirmed in advance.
Meals: breakfast $8/person, lunch $12/person, dinner $15/person, subject to local availability; one nonalcoholic beverage included.
Boat has complimentary Starlink Wi-Fi.
Booking: guests can use the booking form on this website. It prepares a WhatsApp request. Payment is only after availability and deposit amount are confirmed. Stripe is for already-confirmed deposits. Zelle is also displayed on the booking page.
Cancellation: deposits are nonrefundable for guest cancellations within 48 hours. If unsafe weather or operator cancellation requires cancellation, guests may reschedule or receive a full refund.
WhatsApp human help: +1 703-986-7804.
The area is remote/rural; facilities, roads, docks, bathrooms, communications and medical services can be basic or limited.`;
        const system = lang === "es"
          ? `Eres el asistente virtual de Jiquilisco Bay Tours. Responde en español, breve, cálido y práctico. Usa SOLO los datos proporcionados. No inventes horarios, disponibilidad, políticas, precios ni servicios. Nunca confirmes disponibilidad. Para reservar, dirige al formulario de reserva de esta página (#booking); para ayuda humana ofrece WhatsApp. Si no sabes algo, dilo y ofrece WhatsApp. Datos:\n${facts}`
          : `You are the virtual assistant for Jiquilisco Bay Tours. Answer in English, briefly, warmly and practically. Use ONLY the supplied facts. Do not invent schedules, availability, policies, prices or services. Never confirm availability. For booking, direct guests to the booking form on this page (#booking); for human help offer WhatsApp. If you do not know, say so and offer WhatsApp. Facts:\n${facts}`;
        const out = await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {messages:[{role:"system",content:system},{role:"user",content:message}],chat_template_kwargs:{enable_thinking:false}});
        const answer = String(out?.response || out?.result?.response || "").trim();
        return Response.json({answer: answer || (lang === "es" ? "No tengo esa información. Escríbenos por WhatsApp y te ayudamos." : "I don't have that information. Please message us on WhatsApp and we can help.")}, {headers:{"cache-control":"no-store"}});
      } catch (err) {
        return Response.json({answer:"Please message us on WhatsApp for help."}, {status:500,headers:{"cache-control":"no-store"}});
      }
    }

    // Retire URLs from the previous site so search engines consolidate their authority into the new homepage.
    if (["/tours","/about","/contact"].includes(url.pathname.replace(/\/$/, ""))) {
      const destination = host === "bahiajiquilisco.com" ? "https://bahiajiquilisco.com/" : "https://jiquiliscobay.com/";
      return Response.redirect(destination, 301);
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
      if (es) {
        html = html.replace(/<title>[^<]*<\/title>/i,'<title>Bahía de Jiquilisco, El Salvador | Tours, Qué Hacer y Guía de Viaje</title>');
        html = html.replace(/<meta name="description" content="[^"]*">/i,'<meta name="description" content="Descubre la Bahía de Jiquilisco en Usulután, El Salvador: paseos en lancha, manglares, playas, ATV, cabalgatas, precios y consejos para planear tu visita.">');
        html = html.replace(/<h1>[^<]*<\/h1>/i,'<h1>Bahía de Jiquilisco, El Salvador</h1>');
        html = html.replace(/<p class="hero-copy">[^<]*<\/p>/i,'<p class="hero-copy">Descubre la Bahía de Jiquilisco en Usulután: paseos privados en lancha, manglares, islas, playas del Pacífico y experiencias en Punta San Juan del Gozo.</p>');
      } else {
        html = html.replace(/<title>[^<]*<\/title>/i,'<title>Jiquilisco Bay, El Salvador | Tours, Things to Do & Travel Guide</title>');
        html = html.replace(/<meta name="description" content="[^"]*">/i,'<meta name="description" content="Discover Jiquilisco Bay in Usulután, El Salvador: boat tours, mangroves, islands, beaches, ATV rides, horseback riding, prices and trip-planning guides.">');
        html = html.replace(/<h1>[^<]*<\/h1>/i,'<h1>Jiquilisco Bay, El Salvador</h1>');
        html = html.replace(/<p class="hero-copy">[^<]*<\/p>/i,'<p class="hero-copy">Discover Jiquilisco Bay in Usulután with private boat tours, mangrove waterways, islands, remote Pacific beaches and experiences around Punta San Juan del Gozo.</p>');
      }
      // Normalize canonicals to the non-www production domains.
      html = html.replace(/<link rel="canonical" href="[^"]*">/i, `<link rel="canonical" href="${es?'https://bahiajiquilisco.com/':'https://jiquiliscobay.com/'}">`);
      const seo = es
        ? '<link rel="alternate" hreflang="es-SV" href="https://bahiajiquilisco.com/"><link rel="alternate" hreflang="en" href="https://jiquiliscobay.com/"><link rel="alternate" hreflang="x-default" href="https://jiquiliscobay.com/">'
        : '<link rel="alternate" hreflang="en" href="https://jiquiliscobay.com/"><link rel="alternate" hreflang="es-SV" href="https://bahiajiquilisco.com/"><link rel="alternate" hreflang="x-default" href="https://jiquiliscobay.com/">';
      const schema = `<script type="application/ld+json">${JSON.stringify({"@context":"https://schema.org","@type":["TouristInformationCenter","TravelAgency"],"name":"Jiquilisco Bay Tours","url":es?"https://bahiajiquilisco.com/":"https://jiquiliscobay.com/","description":es?"Guía de viaje, paseos en lancha y experiencias en la Bahía de Jiquilisco, Usulután, El Salvador.":"Travel information, boat tours and coastal experiences in Jiquilisco Bay, Usulután, El Salvador.","areaServed":{"@type":"Place","name":"Bahía de Jiquilisco, Usulután, El Salvador"},"sameAs":["https://www.instagram.com/jiquiliscobaytours","https://www.facebook.com/profile.php?id=61590794607731","https://www.tiktok.com/@jiquiliscobaytours"]})}</script>`;
      html = html.replace("</head>", seo + schema + "</head>");
      html = html.replace("</head>", '<link rel="stylesheet" href="/chatbot.css"></head>');\n      html = html.replace("</body>", '<script src="/waiver.js" defer></script><script src="/chatbot.js" defer></script></body>');
    }
    return new Response(html,{status:response.status,statusText:response.statusText,headers:response.headers});
  }
};