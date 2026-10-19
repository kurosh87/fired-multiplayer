# Hosted account test quote

The owner subsequently selected temporary Netlify hosting, using existing
account resources, with OrangeHost or another persistent host to follow later.
The deployment below is an earlier unapproved option, not the current setup.
See [temporary Netlify accounts](NETLIFY-ACCOUNTS.md). The new Netlify Database
uses credit-metered resources on the existing team; no plan, recharge setting,
paid email upgrade, Linux host or Supabase organization has been purchased.

Checked October 17, 2026. All prices are USD. No purchases or provider settings
have changed. This quote covers the first hosted account and persistence test;
the full adventure, multiplayer release and measured 1,000-player goal remain
unfinished.

The recommended first deployment uses the existing **single-API** staging
package. It costs **$73/month in new base services**, plus a sending domain if
one is needed. The earlier **$121/month** proposal uses the larger two-API
gateway package; it remains an optional subsequent routing test.

| Component | New recurring charge | What is selected |
| --- | ---: | --- |
| Linux API host | $48/month | One DigitalOcean Basic Regular bundled Droplet, 4 shared vCPUs, 8 GiB RAM, 160 GiB disk, 5,000 GiB transfer; target west-coast region subject to availability |
| Accounts and database | From $25/month | Separate Kanto Supabase Pro organization, one Micro project in `us-west-2`, with included compute credit |
| Signup/recovery email | $0/month within quota | Resend Free: 3,000 transactional messages/month, at most 100/day, one verified Kanto sending domain; no paid overages selected |
| Browser hosting | No plan upgrade selected | Existing Netlify Pro team and site; existing subscription and team usage remain separate from these new base charges |
| DNS and HTTPS ingress | $0 additional software/license fee | Domain registrar DNS and Caddy on the same Linux host; setup and HTTPS/WebSocket acceptance are still required |
| New base subtotal | **$73/month** | One API with two configured adventure workers; capacity remains unmeasured |

Sources: [Droplet catalog](https://www.digitalocean.com/pricing/droplets),
[Supabase pricing](https://supabase.com/pricing), [Resend pricing](https://resend.com/pricing),
[Caddy HTTPS](https://caddyserver.com/docs/automatic-https).
Netlify project/team plan metadata was checked through its authenticated
read-only connector. This did not establish remaining credits, a usage rate,
or the account's exact invoice; frontend usage is not assumed free.

An existing domain can supply an API hostname and a sending subdomain with no
new registration. If a new domain is wanted, a standard non-premium `.com` is
currently listed from **$11.08/year** at Porkbun. Availability and checkout price
depend on the chosen name. The registrar announces approximately $11.81 from
November 1, 2026. A proposed **$25 first-year domain allowance** leaves room for
that change; it is not purchase permission or an automatic renewal approval.
Sources: [domain prices](https://porkbun.com/products/domains),
[announced increase](https://kb.porkbun.com/article/201-why-did-com-prices-go-up-and-how-high-will-they-go).

With a domain at today's listed price, the single-API example is **$84.08 in
the first month**, then $73/month in base services, before tax, foreign-exchange
fees and metered charges. Using the proposed domain allowance instead gives
a first-month base budget of **$98**. Neither figure is a provider-enforced
total spending cap. Existing Netlify billing is additional.

The two-API alternative uses the reviewed 16 GiB/8 shared-vCPU host at $96/month
plus the same $25 database, email and existing frontend: **$121/month** in new
base charges, or **$146** in the first month including the $25 domain allowance.
Its four configured adventure workers do not establish measured capacity.
See [gateway proposal](GATEWAY-COST.md).

## Billing conditions

Select the quoted bundled Droplet, not a differently priced v5 configuration.
Keep Supabase's spend cap on and choose no additional projects, compute,
branches, paid add-ons, or additional disk/IO capacity. Keep email on Free.
Do not change the existing Netlify team's billing or recharge settings without
separate authorization. Supabase's cap covers only listed usage items, not
every possible charge; its new log-billing grace also needs a creation-time
check. Droplet transfer above its included allowance costs $0.01/GiB, with
allowances pooled at team level. Turning a Droplet off does not end billing.
Sources: [Supabase cost controls](https://supabase.com/docs/guides/platform/cost-control),
[logs pricing transition](https://supabase.com/changelog/logs-usage-based-pricing),
[Droplet billing](https://docs.digitalocean.com/products/droplets/details/pricing/).

No extra load balancer, cache, bucket, paid backup, log service, CI runner or
email upgrade is selected for this private test. Its database uses the Pro
plan's included backup service; disaster recovery and retention still need
verification. No user data or host would be deleted to end billing without
separate authorization and a reviewed preservation plan.

## Work after selection

Use only a dedicated Kanto project and host. Apply the reviewed migrations,
create the restricted runtime login, verify the sending domain and configure
SMTP privately. Resend's [Supabase integration](https://resend.com/docs/send-with-supabase-smtp)
requires a verified domain and an API key. Keep secrets outside browser builds.
Build the Linux package and verify its actual resource limits, apply the
[prepared HTTPS/WSS ingress](HTTPS-STAGING.md), then connect the account frontend
with exact origins and redirects. Native proxy/configuration checks pass; public
certificate issuance and Linux execution remain unverified.

Acceptance must demonstrate signup email/confirmation, unique immutable names,
logout/login/recovery and separate adventure slots. Actual cloud gameplay,
battles and trades also need qualified game artifacts; deployment alone will
not open their admission gates. Full-story and 1,000-player qualification remain
part of the original goal and need their own measured production quote.

The outstanding choice is **existing dedicated resources** (project, Linux host
and sender domain) or **new services at the itemized prices above**. New recurring
charges and domain purchases require the user's approval. Provider checkout,
regional availability and the selected domain must match this scope before any
purchase; a price or scope change goes back for review.
