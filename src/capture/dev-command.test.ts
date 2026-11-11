import assert from 'node:assert/strict';
import test from 'node:test';
import { looksLikeDevServer } from './dev-command';

test('commands that start a dev server, an app, or containers are recognized', () => {
  for (const command of [
    'npm run dev',
    'npm start',
    'pnpm dev',
    'yarn start:api',
    'bun run serve',
    'npx vite --port 3000',
    'next dev',
    'vite',
    'ng serve',
    'node server.js',
    'node --inspect src/index.ts',
    'python manage.py runserver 0.0.0.0:8000',
    'python3 -m uvicorn app.main:app --reload',
    'uvicorn main:app',
    'flask run',
    'poetry run uvicorn app:app',
    'rails s',
    'bundle exec rails server',
    'go run ./cmd/api',
    'cargo run',
    'dotnet watch',
    './gradlew bootRun',
    'mvn spring-boot:run',
    'php artisan serve',
    'mix phx.server',
    'docker compose up',
    'docker-compose -f dev.yml up --build',
    'make dev',
    'PORT=3000 npm run dev',
    'NODE_ENV="development" DEBUG=app:* node server.js',
    'cross-env NODE_ENV=development npm start',
    '  npm run dev  ',
  ])
    assert.equal(looksLikeDevServer(command), true, command);
});

test('everyday commands are not mistaken for one', () => {
  for (const command of [
    '',
    'ls -la',
    'git status',
    'npm install',
    'npm test',
    'npm run build',
    'npm run lint',
    'yarn add vite',
    'cd dev',
    'node --version',
    'node scripts/build.mjs',
    'python script.py',
    'go build ./...',
    'go test ./...',
    'cargo build',
    'dotnet build',
    'docker compose down',
    'docker ps',
    'make build',
    'echo npm run dev',
    'cat server.js',
  ])
    assert.equal(looksLikeDevServer(command), false, command);
});
