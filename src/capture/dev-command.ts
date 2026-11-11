/**
 * Whether a terminal command starts something long-running that logs: a dev
 * server, an app, or a set of containers. Used to offer capture at the moment
 * it would have helped; a miss only means no offer.
 */
const SCRIPT = '(?:dev|start|serve|server|watch|preview)(?::[\\w.-]+)?';
const PATTERNS: RegExp[] = [
  // Package scripts: npm run dev, pnpm dev, yarn start:api, bun run serve.
  new RegExp(`^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?${SCRIPT}(?:\\s|$)`),
  /^(?:npx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|bunx)\s+(?:vite|next|nuxt|nodemon|tsx|ts-node|astro|remix|ng|wrangler)\b/,
  /^(?:vite|nodemon|ts-node-dev)(?:\s|$)/,
  /^(?:next|nuxt|astro|remix)\s+dev\b/,
  /^ng\s+serve\b/,
  /^tsx\s+watch\b/,
  /^(?:node|bun|deno)\s+(?:run\s+)?(?:--[\w=-]+\s+)*\S*(?:server|index|app|main)\.[cm]?[jt]s\b/,
  /^(?:python[\d.]*|py)\s+(?:-m\s+)?(?:uvicorn|gunicorn|flask|hypercorn|daphne|http\.server)\b/,
  /^(?:python[\d.]*|py)\s+\S*manage\.py\s+runserver\b/,
  /^(?:uvicorn|gunicorn|hypercorn|daphne)\s/,
  /^(?:flask|fastapi)\s+(?:run|dev)\b/,
  /^(?:poetry|uv|pipenv|hatch)\s+run\s+(?:uvicorn|gunicorn|flask|fastapi|python)\b/,
  /^(?:bundle\s+exec\s+)?(?:rails|bin\/rails)\s+(?:s|server)\b/,
  /^(?:bin\/dev|foreman\s+start|overmind\s+start)(?:\s|$)/,
  /^go\s+run\b/,
  /^(?:air|cargo\s+(?:run|watch))(?:\s|$)/,
  /^dotnet\s+(?:run|watch)\b/,
  /^(?:\.\/)?(?:mvnw?|gradlew?)\s+\S*(?:spring-boot:run|bootRun|quarkus:dev|quarkusDev)\b/,
  /^php\s+artisan\s+serve\b/,
  /^mix\s+phx\.server\b/,
  /^docker[\s-]compose\s+(?:-\S+\s+\S+\s+)*up\b/,
  /^(?:make|just|task)\s+(?:dev|serve|start|run|up)(?:\s|$)/,
];

export function looksLikeDevServer(commandLine: string): boolean {
  // Leading `VAR=value` assignments and `env`/`cross-env`/`dotenv --` wrappers are part of the same run.
  const command = commandLine
    .trim()
    .replace(/^(?:(?:env|cross-env|dotenv(?:\s+-\S+(?:\s+\S+)?)*\s+--)\s+)?(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)*/, '');
  return PATTERNS.some((pattern) => pattern.test(command));
}
