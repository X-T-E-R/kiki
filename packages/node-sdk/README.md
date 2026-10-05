# @kiki/node-sdk

The TypeScript surface Kiki applications embed: host setup, session control,
and provider wiring, without pulling in the CLI.

This is a workspace package. It is marked `private: true`, so it is not
published to npm as its own release; the examples below assume a repository
checkout rather than an installed dependency.

`@kiki/klient` is the contract-validated client facade, and it is the surface to
reach for when you want zod-checked calls and swappable transports. Reach for
this package when you are hosting the agent inside your own process —
`apps/kimi-code` builds its CLI on it.

## License

MIT
