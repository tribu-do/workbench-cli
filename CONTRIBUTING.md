# Contributing to Workbench

## Development Setup

```bash
# Clone the repo
git clone https://github.com/tribu-do/workbench-cli.git
cd workbench-cli

# Install dependencies
npm install

# Build
npm run build

# Run during development
npm run dev -- --help

# Type check
npm run typecheck
```

## Project Structure

```
src/
├── cli/           # CLI commands and UI
├── memory/        # Hierarchical memory service
├── runtime/       # Runtime backends (docker, worktree)
├── stores/        # File-based persistence
├── diagrams/      # Diagram management
├── agents/        # Agent provider integrations
└── *.ts           # Core services (orchestrator, secrets, ports, etc.)
```

## Testing

```bash
npm run build
npm test
```

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm run typecheck` and `npm test`
4. Submit a PR with a clear description

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
