# Frontend

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.1.8.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Deployment

Das Frontend läuft als eigenständiges Cloudflare-Workers-Projekt mit
Static-Assets-Hosting (`3d-druck-platform`, getrennt vom API-Worker
`3d-druck-platform-api` in `cloudflare-worker/`). Konfiguration siehe
`wrangler.toml` (`[assets] directory`, `not_found_handling =
"single-page-application"` für client-seitiges Routing ohne 404 bei
direkten Unterseiten-Aufrufen).

Im `frontend/`-Verzeichnis, in dieser Reihenfolge:

```bash
npm install
ng build --configuration production
wrangler deploy
```

`ng build --configuration production` bettet die Werte aus
`src/environments/environment.prod.ts` (Supabase-URL/-Key, Worker-API-URL,
Turnstile-Site-Key) zur Build-Zeit ein — kein `[vars]`-Block in
`wrangler.toml` nötig, da diese zur Laufzeit nicht mehr gelesen werden.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
