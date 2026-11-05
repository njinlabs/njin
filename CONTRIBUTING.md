# Contributing

Thank you for considering a contribution to njin. Bug reports, fixes, documentation and ideas are all welcome.

## Before you start

- For a bug, search the [issues](https://github.com/njinlabs/njin/issues) first, then open one with the steps to reproduce it.
- For a new feature or a larger change, open an issue to talk it through before you write the code. It saves everyone time.

## Setting up

njin runs on [Bun](https://bun.sh).

```bash
git clone https://github.com/njinlabs/njin.git
cd njin
bun install
```

Before you open a pull request, make sure these pass:

```bash
bun run test
bun run lint
bunx tsc --noEmit
```

## Pull requests

- Branch from `main` and keep the change focused on one thing.
- Add or update tests for the behavior you change.
- Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org) style, like the history does (`feat: …`, `fix: …`, `docs: …`). Mark a breaking change with `!` or a `BREAKING CHANGE` note.
- Describe what changed and why in the pull request.

## Code of conduct

This project follows a [code of conduct](CODE_OF_CONDUCT.md). Be respectful and constructive; harassment or abuse is not tolerated. Questions are welcome in [Discussions](https://github.com/njinlabs/njin/discussions).

## Security

Please do not report security problems in an issue. See the [security policy](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT license](LICENSE).
