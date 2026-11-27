import assert from 'node:assert/strict';
import test from 'node:test';
import { looksLikeDevServer, looksLikeProgramRun, looksLikeTestRun } from './dev-command';

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
    'env PORT=3000 node server.js',
    'dotenv -e .env.local -- npm run dev',
    'dotenv -- next dev',
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
    'dotenv -e .env.local npm test',
    'FOO=bar',
  ])
    assert.equal(looksLikeDevServer(command), false, command);
});

test('a long or adversarial command line is answered at once', () => {
  const started = performance.now();
  // Shapes that make a backtracking pattern take exponential time.
  for (const command of [
    `dotenv${' -! -!'.repeat(300)}`,
    `dotenv -!${' -! -!'.repeat(300)} x`,
    `${'A=1 '.repeat(400)}x`,
    `node ${'--a=b '.repeat(300)}x`,
    `docker compose ${'-f x '.repeat(300)}down`,
    'x'.repeat(100_000),
  ])
    assert.equal(looksLikeDevServer(command), false);
  assert.equal(looksLikeDevServer(`${'A=1 '.repeat(400)}npm run dev`), true);
  assert.ok(performance.now() - started < 500, 'each answer takes time in proportion to the length');
});

test('the capture offer also recognizes programs and test suites, but not builds or shell commands', () => {
  for (const command of [
    'npm run dev',
    'python app.py',
    'python3 -u main.py --port 8000',
    'py .\\scripts\\worker.py',
    'python -m pytest tests',
    'node scripts/seed.mjs',
    'node --env-file=.env src/job.ts',
    'deno run --allow-net main.ts',
    'npm test',
    'npm t',
    'pnpm test:unit',
    'yarn run test --watch',
    'npx vitest',
    'jest --runInBand',
    'pytest -k login',
    'uv run pytest',
    'go test ./...',
    'cargo test',
    'dotnet test',
    '.\\gradlew.bat test',
    './mvnw -q test',
    'bundle exec rspec',
    'NODE_ENV=test npm test',
  ])
    assert.equal(looksLikeProgramRun(command), true, command);
  for (const command of [
    '',
    'git status',
    'npm install',
    'npm run build',
    'node --version',
    'python --version',
    'python',
    'pip install -r requirements.txt',
    'go build ./...',
    'cargo build',
    'dotnet build',
    './gradlew build',
    'cat app.py',
    'echo npm test',
  ])
    assert.equal(looksLikeProgramRun(command), false, command);
  assert.equal(looksLikeDevServer('python app.py'), false, 'the browser offer still waits for a server');
});

test('a long or adversarial command line is answered at once for the capture offer too', () => {
  const started = performance.now();
  for (const command of [
    `python ${'-X '.repeat(400)}x`,
    `node ${'--a=b '.repeat(300)}x`,
    `./gradlew ${'a '.repeat(500)}build`,
    `py ${'a'.repeat(1900)}`,
  ])
    assert.equal(looksLikeProgramRun(command), false, command.slice(0, 20));
  assert.ok(performance.now() - started < 500, 'each answer takes time in proportion to the length');
});

test('test commands are told apart from other program runs', () => {
  for (const command of [
    'npm test',
    'npm t',
    'pnpm run test:unit',
    'npx vitest run src/cart.test.ts',
    'jest --runInBand',
    'pytest -k login',
    'python -m pytest tests',
    'node --test out/',
    'go test ./...',
    'dotnet test',
    './mvnw -q test',
    'NODE_ENV=test npm test',
  ])
    assert.equal(looksLikeTestRun(command), true, command);
  for (const command of ['npm run dev', 'node server.js', 'python app.py', './gradlew bootRun', 'npm install', ''])
    assert.equal(looksLikeTestRun(command), false, command);
});
