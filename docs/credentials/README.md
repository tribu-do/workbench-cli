# Workbench Configuration

Workbench stores global configuration in `~/.workbench.toml`. This file is read by the CLI at startup.

## Setup

The file is created automatically by `workbench init`. To create manually:

```bash
touch ~/.workbench.toml
chmod 600 ~/.workbench.toml
```

## Structure

```toml
# ~/.workbench.toml

[agents]
openai_api_key = "sk-..."
anthropic_api_key = "sk-ant-..."
github_token = "ghp_..."
ollama_url = "http://localhost:11434"

[memory]
backend = "openviking"
openviking_url = "http://localhost:8000"
openviking_mode = "embedded"

[deployments.coolify]
url = "https://your-coolify-instance.example.com"
token = "your-api-token"

[deployments.netlify]
token = "your-netlify-token"
site_id = "your-site-id"

[deployments.cloudflare]
api_token = "your-cf-token"
account_id = "your-account-id"

[docs]
preset = "openai"
embedding_model = "text-embedding-3-small"
api_base = "http://localhost:11434/v1"
```

## Sections

### `[agents]`

API keys for AI agent providers:

| Key | Description |
|-----|-------------|
| `openai_api_key` | OpenAI API key for Codex |
| `anthropic_api_key` | Anthropic API key for Claude |
| `github_token` | GitHub token for Copilot |
| `ollama_url` | Local Ollama endpoint |

### `[memory]`

Memory backend configuration:

| Key | Description |
|-----|-------------|
| `backend` | Memory backend (`openviking`, `filesystem`) |
| `openviking_url` | OpenViking service URL |
| `openviking_mode` | Mode (`embedded`, `client-docker`) |

### `[deployments.*]`

Preview deployment provider credentials:

- `[deployments.coolify]` — Full-stack previews
- `[deployments.netlify]` — Static site previews
- `[deployments.cloudflare]` — Edge/Workers previews

### `[docs]`

Documentation embedding configuration:

| Key | Description |
|-----|-------------|
| `preset` | Provider (`openai`, `ollama`, `lm-studio`) |
| `embedding_model` | Model identifier |
| `api_base` | API endpoint (for ollama/lm-studio) |

## Security

- `~/.workbench.toml` must have `600` permissions (owner read/write only).
- Never commit this file to version control.
- Workbench warns if permissions are too open.

## Credential vs. Secret

| Concept | Location | Purpose |
|---------|----------|---------|
| **Credential** | `~/.workbench.toml` | Cloud provider auth, agent API keys. CLI startup. |
| **Secret** | `.workbench/secrets/` | Application secrets injected into tasks (`DATABASE_URL`, etc.). Deny-by-default. |

Credentials configure Workbench operators. Secrets configure agents running inside tasks.

## See Also

- [Usage — workbench secret](../usage/README.md#workbench-secret) — task-scoped secret management
- [Usage — Configuration](../usage/README.md#configuration) — `workbench.yaml` settings
- [Deployment](../deployment/README.md) — provider-specific deployment context
