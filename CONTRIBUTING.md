# Contributing to mcp-searxng

We welcome contributions! Follow these guidelines to get started.

Please read and follow the [Code of Conduct](CODE_OF_CONDUCT.md) when participating in this project.

## Getting Started

```bash
git clone https://github.com/YOUR_USERNAME/mcp-searxng.git
cd mcp-searxng
git remote add upstream https://github.com/ihor-sokoliuk/mcp-searxng.git
npm install
```

## Development Workflow

```bash
npm run watch   # Watch mode — rebuilds on file changes
npm run build   # One-off build
```

## Coding Standards

- Use TypeScript with strict type safety
- Follow existing error handling patterns
- Write concise, informative error messages
- Include unit tests for new functionality
- Keep coverage above the enforced gate — **90% lines, 85% branches** (CI runs `npm run test:coverage` and fails below it)
- Run `npm run lint` (or `npm run security` for lint + dependency audit) before submitting
- Test with the MCP inspector (`npm run inspector`) before submitting

## Testing

```bash
npm test                  # Run all tests
npm run test:coverage     # Generate coverage report
```

## Submitting a PR

```bash
git checkout -b feature/your-feature-name
# Make changes in src/
npm run build
npm test
npm run test:coverage
npm run inspector
git commit -m "feat: description"
git push origin feature/your-feature-name
# Open a PR on GitHub
```

## Documentation changes

Write for a reader completing a task. Keep configuration defaults in
[CONFIGURATION.md](CONFIGURATION.md), tool arguments in [the tool guide](docs/tools.md),
client setup in [the cookbook](docs/client-configurations.md), and failure
diagnosis in [troubleshooting](docs/troubleshooting.md). Update affected
built-in help when behavior changes; link to detail instead of copying it.

Check examples, local links and existing anchors when moving content. Record
whether client guidance was checked against its official schema or actually
exercised, with the date and known versions. Do not describe unreleased
behavior as available to installed-package users. Preserve dated historical
verification results with their limitations.

In each PR, state what is included and intentionally out of scope. Record
validation as example/area, check, environment/version and result or limitation.
Use focused documentation tests for prose changes; include build/resource or
handler checks when embedded help or a behavior claim needs verification.
