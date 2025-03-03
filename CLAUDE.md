# Spotify Video Blocker - Development Guidelines

## Build & Run Commands

```
npm install              # Install dependencies
npm start                # Run the application (node index.js)
node index.js            # Start the application manually
```

## Interactive Commands

While the application is running:

- `r` - Generate a report of detected video domains
- `e` - Export domains to CSV
- `q` - Quit the application

## Code Style Guidelines

- **Formatting**: Use 2-space indentation for JS files
- **Naming**: Use camelCase for variables and functions, UPPER_CASE for constants
- **Comments**: Use block comments with descriptive headers for sections
- **Error Handling**: Use try/catch with specific error messages
- **File Structure**: Group related functionality in organized sections
- **Imports**: List core Node.js modules first, then external dependencies
- **Utility Functions**: Use a utils object to organize helper functions
- **Configuration**: Store configuration values in a dedicated CONFIG object
- **Promises**: Use async/await pattern with proper error handling
- **Classes/Objects**: Organize related methods within objects (e.g., core)
- **Types**: Use JSDoc comments for function parameters when needed
