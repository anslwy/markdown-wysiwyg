# Markdown WYSIWYG

A WYSIWYG / Preview / Source markdown Custom Text Editor extension for VSCode (desktop + web).

## Development

- **Standalone browser harness** (live markdown sync on the right):
  ```bash
  npm run dev
  ```
- **Desktop VSCode**: open this folder in VSCode and press **F5** (launches an Extension Development Host with `./sample` open).
- **VSCode for the Web**:
  ```bash
  npm run web
  # then open http://localhost:3010
  ```
- **Build / Test / Package**:
  ```bash
  npm run build
  npm test
  npm run package   # produces a .vsix you can install in VSCode
  ```

## Releases

Pushing a version tag (e.g. `git tag v0.0.1 && git push origin v0.0.1`) or running the **Release VSIX** workflow manually in GitHub Actions builds, tests, packages the `.vsix`, and attaches it to a GitHub Release.
