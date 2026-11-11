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

/** Longer than any command someone types to start a server; nothing longer is examined. */
const MAX_COMMAND = 2000;
const ASSIGNMENT = /^\w+=(?:"[^"]*"|'[^']*'|\S*)\s+/;

/**
 * The command without what only sets its environment: an `env` or `cross-env`
 * wrapper, `dotenv … --`, and leading `VAR=value` assignments. Each step takes
 * one piece off the front, so the time taken grows with the length only.
 */
function withoutEnvironment(commandLine: string): string {
  let rest = commandLine.trim();
  const wrapper = /^(?:env|cross-env)\s+/.exec(rest);
  if (wrapper) rest = rest.slice(wrapper[0].length);
  else if (/^dotenv\s/.test(rest)) {
    const separator = rest.indexOf(' -- ');
    if (separator !== -1) rest = rest.slice(separator + 4).trimStart();
  }
  for (let assignment = ASSIGNMENT.exec(rest); assignment; assignment = ASSIGNMENT.exec(rest))
    rest = rest.slice(assignment[0].length);
  return rest;
}

export function looksLikeDevServer(commandLine: string): boolean {
  if (commandLine.length > MAX_COMMAND) return false;
  const command = withoutEnvironment(commandLine);
  return PATTERNS.some((pattern) => pattern.test(command));
}
