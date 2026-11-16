# Reservation system setup

The booking backend is implemented in `reservation-api.js` and is called by the existing bilingual Cloudflare Worker. The current production configuration remains static until an owner creates and binds the database and adds the required secrets. Without `RESERVATIONS_DB`, the new API returns a setup message and the existing WhatsApp inquiry fallback remains available.

## Cloudflare database

1. Create a D1 database named `jiquilisco-reservations` in the Cloudflare account serving the Worker.
2. Copy `wrangler.reservations.example.jsonc` to `wrangler.reservations.jsonc` and replace the database ID with the newly created D1 ID.
3. Run `npx wrangler d1 migrations apply jiquilisco-reservations --remote --config wrangler.reservations.jsonc`.
4. Add the D1 binding and hourly cron trigger from that config to the Worker deployment configuration, then deploy a preview and verify both domains before moving production traffic.

The booking calendar currently reserves one tour per date. This conservative rule prevents two administrators from approving the same operating day while the business has one boat and shared local activity suppliers. Reservation requests do not block dates; a successful approval creates a unique database reservation for that date.

## Secrets and service bindings

Set these as Worker secrets or bindings. Never put their values in the repository.

- `ADMIN_SETUP_TOKEN`: a random, one-time value for first owner account creation. Remove it after setup.
- `STRIPE_SECRET_KEY`: the existing Stripe account's restricted or standard secret key. Use Stripe test mode for preview.
- `STRIPE_WEBHOOK_SECRET`: signing secret for `POST /api/payments/webhook`; subscribe to `checkout.session.completed`.
- `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`: Meta WhatsApp Cloud API credentials for the existing business number, if that number supports Cloud API coexistence.
- `WHATSAPP_ADMIN_TEMPLATE` and `WHATSAPP_CUSTOMER_TEMPLATE`: approved WhatsApp templates, in that order, with six body variables for event, name, date, time, tour, and portal link.
- `EMAIL`: Cloudflare Email binding. `BOOKING_EMAIL_FROM` can override the verified sender address; otherwise the Worker uses `reservations@jiquiliscobay.com`.

WhatsApp sends use approved templates, which allows messages outside the 24-hour customer service window. Meta supports coexistence for an existing WhatsApp Business app number, but onboarding requires Meta Embedded Signup through a Solution Partner or Tech Provider. One-to-one messages and recent history can remain synchronized, while some app features change: broadcast lists become read-only, and some messaging tools are unavailable through Cloud API. Do not onboard the current number until the owner reviews those changes and approves the Meta setup. The existing `wa.me` inquiry link stays in place.

## First account and staff

Open `/admin.html` on the site, complete first-time owner setup, and use a unique password of at least 12 characters. Then invite Abdias and Joel from Owner controls using each person's email address and WhatsApp destination number. The secure invitation expires after seven days. Owner controls can revoke accounts and remove their booking access.

The reservation portal is `/portal.html`. Customers receive a one-time access link by email and can use it to view the request, accept an alternative date, request one eligible reschedule, cancel, and pay using Stripe Checkout. An account link is refreshed in each notification email.

## Payments and policy behavior

- Admin approval creates the exclusive date reservation and requests a 25% deposit through Stripe Checkout.
- The remaining balance is due by the timestamp 24 hours before departure; a scheduled reminder runs hourly.
- Stripe webhook events move the reservation to deposit-paid or confirmed status.
- Customer cancellation keeps the 25% deposit nonrefundable by default. Owner-only refunds can be issued for operator cancellations; a customer cancellation deposit refund is only enabled if the owner changes that policy.
- One reschedule request is permitted at least 72 hours before departure and must fall within 90 days of the original date. The team approves the proposed date; operator cancellations can offer a full refund or rescheduling.

## Release checks

Keep the current DNS and hosting in place until the D1 binding and secrets are configured and the reservation flow has been exercised on a preview. Verify the English and Spanish home pages, one request, date approval conflict, alternative date, one reschedule, deposit, balance, cancellation, refund, email delivery, WhatsApp delivery, and reminder job. Production Stripe and WhatsApp settings require explicit owner approval before activation.
