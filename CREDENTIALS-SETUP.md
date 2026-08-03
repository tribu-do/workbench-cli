# Workbench Credentials Setup

Workbench stores remote/cloud auth credentials and sensitive environment variables at **`~/.workbench`** in your home directory. This file is sourced by the daemon and CLI at startup.

## Setup

Create the credentials file:

```bash
touch ~/.workbench
chmod 600 ~/.workbench
```

## Coolify

Workbench uses Coolify as the default deployment provider for full-stack previews.

```bash
cat >> ~/.workbench << 'EOF'
# Coolify API — https://coolify.io/docs/api-reference/authorization
# The API can be accessed through http://<ip>:8000/api
export WORKBENCH_COOLIFY_URL="https://your-coolify-instance.example.com"
export WORKBENCH_COOLIFY_TOKEN="your-api-token-here"
EOF
```

## Netlify

For static/marketing preview deployments:

```bash
cat >> ~/.workbench << 'EOF'
# Netlify
export WORKBENCH_NETLIFY_TOKEN="your-netlify-token"
export WORKBENCH_NETLIFY_SITE_ID="your-site-id"
EOF
```

## Cloudflare

For edge/Workers preview deployments:

```bash
cat >> ~/.workbench << 'EOF'
# Cloudflare
export WORKBENCH_CLOUDFLARE_API_TOKEN="your-cf-token"
export WORKBENCH_CLOUDFLARE_ACCOUNT_ID="your-account-id"
EOF
```

## Other Services

Add any other service credentials following the same pattern. Use the `WORKBENCH_` prefix for consistency:

```bash
export WORKBENCH_<SERVICE>_<KEY>="value"
```

## Security Notes

- The `~/.workbench` file should have `600` permissions (owner read/write only).
- Never commit this file to version control.
- Workbench will warn if permissions are too open.
- For team environments, consider using a secrets manager backend (`WORKBENCH_SECRET_BACKEND=vault|aws-sm`).
