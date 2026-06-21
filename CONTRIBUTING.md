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
- Test with MCP inspector before submitting
- Run evals to verify functionality

## Testing

```bash
npm test                  # Run all tests
npm run test:coverage     # Generate coverage report
npm run test:watch        # Watch mode
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
