# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this package, please report it to us.

**DO NOT** create a public GitHub issue for security vulnerabilities.

### How to Report

Email: support@revenium.io

Please include:
- Package name and version
- Description of the vulnerability
- Steps to reproduce (if applicable)
- Potential impact
- Suggested fix (if available)

We will review and respond to security reports in a timely manner.

## Security Best Practices

When using this CLI tool:

1. **API Keys**: Never commit API keys to version control
2. **Config Files**: The tool stores config with restricted permissions (0o600) in:
   - Claude Code: `~/.claude/revenium.env`
   - Gemini CLI: `~/.gemini/revenium.env`
   - Cursor IDE: `~/.cursor/revenium/revenium.env`
3. **Network Security**: All connections use HTTPS
4. **Updates**: Keep the package updated to the latest version

## Data Transmission

This tool sends usage telemetry via OTLP format. The data transmitted includes:
- Model used
- Token counts (input, output, cache read, cache creation)
- Cost in USD
- Timestamps
- Cost multiplier (subscription tier)
- Email (when configured by the user for attribution)
- Organization and product name (when configured)

For Cursor IDE specifically, additional billing metadata is included (token fee, request costs, billing kind).

No conversation content is transmitted.

## Additional Resources

- [Revenium Documentation](https://docs.revenium.io)
