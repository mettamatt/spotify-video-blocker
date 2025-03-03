# Spotify Video Blocker - Development Guidelines

## Build & Run Commands

```bash
# Install dependencies
npm install

# Run the application
npm start  # (alias for node index.js)
```

## Interactive Runtime Commands

- `r` - Generate report of detected video domains
- `e` - Export domains to CSV
- `q` - Quit the application

## Code Style Guidelines

### Structure

- Use descriptive section headers with comment blocks (`//==============`)
- Group related functionality in logical sections
- Top-level functions use camelCase

### Formatting

- 2-space indentation
- Semi-colons required
- Block-level scoping with braces on same line
- Max line length ~80 characters

### Naming Conventions

- Constants: UPPER_CASE with underscores
- Variables/Functions: camelCase
- Configuration objects: ALL_CAPS properties

### Error Handling

- Use try/catch with specific error messages
- Wrap event handlers in error-catching functions
- Provide fallbacks for file operations

### Imports

- Core Node.js modules first, then external dependencies
- Group imports by source/type

### JS Style

- Use const/let over var
- Favor async/await over raw Promises
- Use Set/Map for collections where appropriate
