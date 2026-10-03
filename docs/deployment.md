# Deployment and advanced setup

For the local quick start, see the [README](../README.md) or [setup guide](https://docs.apteva.ai/#quickstart).

## Published Docker image

```bash
docker run -d \
  --name apteva \
  -p 5280:5280 \
  -v apteva-data:/data \
  ghcr.io/apteva/apteva:latest
```

Open [http://localhost:5280](http://localhost:5280). Pin a numbered image tag instead of `latest` for production deployments.

## Your domain and HTTPS

Use **Settings → Server → Domain & HTTPS** or `apteva https setup` for a guided setup. Choose native automatic certificates, Cloudflare DNS validation, an existing proxy/tunnel, or an imported certificate. No Domains app is required.

```bash
apteva https setup agents.example.com --accept-terms
apteva https status
apteva https doctor
```

Use `apteva https setup --help` for Cloudflare, certificate import, listener ports, and instance selection. A new public URL activates only after HTTPS verification.

## Local country lookup

Local country lookup is enabled by default using DB-IP Country Lite, downloaded anonymously and refreshed monthly. Use `apteva geoip setup --test` for development, or provide a MaxMind account ID and license key to use GeoLite2 Country instead.

The server refreshes configured databases in the background and keeps serving with the last known-good copy if an update fails. DB-IP Country Lite data is provided by [DB-IP](https://db-ip.com) under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Build the release image from source

`deploy/Dockerfile.server` uses the same sibling checkout layout as GitHub Actions:

```text
workspace/
  apteva/
  core/
  server/
  computer/
  dashboard/
  ui-kit/
  app-sdk/
  integrations/
```

Run from the parent workspace directory:

```bash
docker build -f apteva/deploy/Dockerfile.server \
  -t ghcr.io/apteva/apteva:dev .
```

The build context remains the parent workspace; moving the Dockerfile into `deploy/` does not change its `COPY` paths. `deploy/Dockerfile` retains the older headless build definition; the release workflow uses `deploy/Dockerfile.server`.
