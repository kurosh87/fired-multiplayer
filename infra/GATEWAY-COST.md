# Private gateway hosting proposal

Prices checked October 17, 2026. This covers the existing private two-API
qualification profile. Nothing has been approved, purchased or deployed.

The [itemized hosted-account quote](HOSTING-QUOTE.md) adds email, domain,
existing frontend-plan observations and billing conditions. It also offers the
existing single-API package at $73/month in new base charges for the first
account test; the larger gateway remains a separate $121/month option.

The profile caps two APIs at 4 GiB each and the gateway at 512 MiB: 8.5 GiB
before host overhead. Its CPU ceilings total 5 units. The earlier 8 GiB host
proposal remains a single-API option; it cannot hold this complete profile.

| Component | Starting USD/month |
| --- | ---: |
| DigitalOcean Basic Regular, 8 shared vCPUs, 16 GiB | $96 |
| Dedicated Supabase Pro organization, one Micro project | $25 |
| Initial functional-test subtotal | **$121** |
| Alternative: CPU-Optimized Regular, 8 dedicated vCPUs, 16 GiB, plus Auth/database | **$193** |

The host prices are bundled plans. The Micro compute estimate uses the Pro
plan's included credit. Sources: [DigitalOcean catalog](https://www.digitalocean.com/pricing/droplets),
[billing details](https://docs.digitalocean.com/products/droplets/details/pricing/),
and [Supabase pricing](https://supabase.com/pricing).

SMTP/domain, frontend usage, ingress setup, tax, optional backups/monitoring and
metered overages remain outside these subtotals. Supabase's new log pricing has
a grace period whose duration is not guaranteed for newly created organizations;
recheck it before creation. See the [announcement](https://supabase.com/changelog/logs-usage-based-pricing).

This profile configures two adventure workers per API: four in total. Neither
subtotal sizes 1,000 active players. The 16 GiB host leaves a nominal 7.5 GiB
outside container ceilings; actual host overhead and cloud CPU throughput still
need measurement. Exact plan/region availability and account charges must be
confirmed before provisioning. The machine-readable proposal is
[gateway-cost-plan.json](gateway-cost-plan.json).
