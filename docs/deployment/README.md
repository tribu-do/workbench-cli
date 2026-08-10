# Workbench Deployment

## Preview Deployment Model

Workbench generates preview deployments for task branches automatically. Each task can produce a preview URL via the configured provider. Previews are tied to the task lifecycle and garbage-collected when tasks complete or are aborted.

## Providers

### Coolify (Full-Stack Previews)

Self-hosted PaaS running on DigitalOcean. Used for:
- full-stack applications (backend + frontend + databases)
- Docker-compatible service deployments
- SSL automation, backup/restore, monitoring

Credentials: `WORKBENCH_COOLIFY_URL`, `WORKBENCH_COOLIFY_TOKEN`

### Netlify (Static and Marketing Previews)

Mandatory for MVP. Used for:
- static frontends
- fast showcase loop for prototypes and UI checkpoints

Credentials: `WORKBENCH_NETLIFY_TOKEN`, `WORKBENCH_NETLIFY_SITE_ID`

### Cloudflare (Edge and Workers Previews)

Included in MVP via the same provider interface as Netlify. Used for:
- edge/Workers deployments
- CDN-backed static delivery

Credentials: `WORKBENCH_CLOUDFLARE_API_TOKEN`, `WORKBENCH_CLOUDFLARE_ACCOUNT_ID`

## Provider Selection Rules

Provider is selected via `workbench.yaml` rules evaluated against the artifact kind:

```yaml
preview:
  default: coolify
  rules:
    - when: "artifact.kind == 'static'"
      provider: netlify
    - when: "artifact.kind == 'edge'"
      provider: cloudflare
```

Override at deploy time with `--provider`:

```bash
workbench deploy preview <taskId> --provider netlify --build-command "npm run build"
```

## CLI

```bash
# Deploy
workbench deploy preview <taskId>

# Check status
workbench deploy status <taskId>

# Tear down
workbench deploy destroy <taskId>
```

## Garbage Collection

Previews are automatically cleaned up:

| Trigger | Delay |
|---|---|
| Task merged | 1 hour |
| Task aborted | Immediate |
| Idle (no activity) | 7 days + 24h grace |
| Max active per workspace | 10 (configurable) |

```yaml
preview:
  gc:
    afterMergeDelayMs: 3600000
    suspendTtlMs: 259200000
    idleTtlMs: 604800000
    maxActivePerWorkspace: 10
```

## Provider Interface

All providers implement the same abstract interface. Adding a new provider requires implementing three operations:
- **deploy** — build and push the artifact
- **status** — poll the provider for current state and URL
- **destroy** — tear down the preview

## Deployment Flow

1. Task branch contains a built artifact.
2. `workbench deploy preview <taskId>` selects the provider by rule or flag.
3. Provider builds and deploys the artifact.
4. Preview URL is returned and logged to the task record.
5. On task completion or abort, GC triggers according to the configured TTLs.

## See Also

- [Credentials](../credentials/README.md) — provider credential setup
- [Architecture](../architecture/README.md) — provider abstraction in component topology
- [Usage — workbench deploy](../usage/README.md#workbench-deploy) — CLI reference
