# safe

**safe** is a self-hosted, open-source secrets manager. Teams store secrets per
project and environment, manage them in a web admin UI, and pull/push/inject them
via the `safe` CLI — including in CI with scoped service tokens. Built on Bun +
Elysia + Redis + SQLite, with envelope encryption so secrets are always encrypted
at rest.

**Status: under development.**

## License

[AGPL-3.0](./LICENSE)
