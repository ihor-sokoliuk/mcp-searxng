# Contributing to mcp-searxng

We welcome contributions! Follow these guidelines to get started.

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
- Maintain 80%+ test coverage
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
