import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLogCall, enclosingScope, insertedLines, isInsertedLine, loggedValue, planInsertion } from './log-insert';
import { extractLogSites } from './log-sites';

const plan = (file: string, lines: string[], line: number, expression: string) =>
  planInsertion({ file, text: lines.join('\n'), line, expression });

test('detects the logging call a file uses most, at a quiet level', () => {
  assert.deepEqual(detectLogCall('logger.info({ id }, "a");\nlogger.error("b");\nconsole.log("c");'), {
    receiver: 'logger.',
    method: 'info',
    objectFirst: true,
  });
  assert.deepEqual(detectLogCall('console.log("a");\nconsole.log("b");\nlogger.debug("c");'), {
    receiver: 'console.',
    method: 'log',
    objectFirst: false,
  });
  // Seen only at error level, the receiver still logs at info.
  assert.equal(detectLogCall('log.error("a");')?.method, 'info');
  assert.equal(detectLogCall('slog.Error("a")')?.method, 'Info');
  assert.equal(detectLogCall('_logger.LogDebug("a");')?.method, 'LogDebug');
  assert.deepEqual(detectLogCall('info!("a {}", x);'), { receiver: '', method: 'info!', objectFirst: false });
  assert.equal(detectLogCall('$this->logger->info("a");')?.receiver, '$this->logger->');
  assert.equal(detectLogCall('const x = 1;'), undefined);
  // A logarithm is not a logging call.
  assert.equal(detectLogCall('const a = Math.log(r) + Math.log(2);\nconsole.log(a);')?.receiver, 'console.');
  assert.equal(detectLogCall('y = math.log(x) + np.log(x)'), undefined);
  assert.equal(detectLogCall('this.logger.log("a");')?.receiver, 'this.logger.');
});

test('inserts a pino-style structured line after the statement at the cursor', () => {
  const lines = [
    'import { logger } from "./log";',
    'export async function checkout(req) {',
    '  const order = await orders.load(req.params.id);',
    '  logger.info({ id: 1 }, "loaded");',
    '  return order;',
    '}',
  ];
  assert.deepEqual(plan('src/checkout.ts', lines, 2, 'order'), {
    line: 3,
    text: '  logger.info({ order }, "checkout: order"); // logline',
    label: 'checkout: order',
    family: 'js',
    styled: true,
  });
  // A member expression is logged under its last name.
  assert.equal(
    plan('src/checkout.ts', lines, 2, 'req.params.id')?.text,
    '  logger.info({ id: req.params.id }, "checkout: req.params.id"); // logline',
  );
});

test('uses the console when a JavaScript file logs nothing yet', () => {
  const lines = ['function total(items) {', '  const sum = items.length;', '}'];
  assert.equal(plan('a.js', lines, 1, 'sum')?.text, '  console.log("total: sum", sum); // logline');
  assert.equal(plan('a.js', lines, 1, '')?.text, '  console.log("total: reached line 3"); // logline');
});

test('follows a multi-line statement to its end and stays out of object literals', () => {
  const lines = ['function x() {', '  const o = {', '    a: 1,', '  };', '  return o;', '}'];
  assert.equal(plan('a.ts', lines, 1, 'o')?.line, 4);
  const call = ['function x() {', '  send(', '    a,', '    b,', '  );', '}'];
  assert.equal(plan('a.ts', call, 1, 'a')?.line, 5);
});

test('goes inside a block the line opens and before a line that leaves the function', () => {
  const callback = ['app.get("/", async (req, res) => {', '    res.send(1);', '});'];
  assert.deepEqual(plan('a.ts', callback, 0, 'req.query'), {
    line: 1,
    text: '    console.log("a: req.query", req.query); // logline',
    label: 'a: req.query',
    // No logging call in the file: the language's own print, which usage counts tell apart.
    family: 'js',
    styled: false,
  });
  const exit = ['function f(x) {', '  return compute(x);', '}'];
  assert.equal(plan('a.ts', exit, 1, 'x')?.line, 1);
  const closing = ['function f(x) {', '  go(x);', '}'];
  assert.deepEqual(
    [plan('a.ts', closing, 2, 'x')?.line, plan('a.ts', closing, 2, 'x')?.text.match(/^\s*/)?.[0]],
    [2, '  '],
  );
});

test('writes each language in the style its file uses', () => {
  const cases: [string, string[], number, string, string][] = [
    [
      'a.py',
      [
        'import logging',
        'logger = logging.getLogger(__name__)',
        '',
        'def charge(order):',
        '    logger.info("x %s", 1)',
      ],
      3,
      'order',
      '    logger.info("charge: order=%r", order) # logline',
    ],
    [
      'a.py',
      ['def charge(order):', '    card = order.card'],
      1,
      'card',
      '    print("charge: card =", repr(card)) # logline',
    ],
    [
      'a.go',
      [
        'package main',
        'import "log/slog"',
        'func Charge(o *Order) error {',
        '\tslog.Info("charging", "id", o.ID)',
        '}',
      ],
      2,
      'o',
      '\tslog.Info("Charge: o", "o", o) // logline',
    ],
    [
      'a.go',
      ['package main', 'import "go.uber.org/zap"', 'func Run(n int) {', '\tlogger.Info("start")', '}'],
      2,
      'n',
      '\tlogger.Info("Run: n", zap.Any("n", n)) // logline',
    ],
    [
      'a.go',
      ['package main', 'import "fmt"', 'func main() {', '\tx := 1', '}'],
      3,
      'x',
      '\tfmt.Printf("main: x=%+v\\n", x) // logline',
    ],
    [
      'A.java',
      ['class A {', '  public void charge(Order order) {', '    log.info("charging {}", order.getId());', '  }', '}'],
      1,
      'order',
      '    log.info("charge: order={}", order); // logline',
    ],
    [
      'A.cs',
      [
        'class A',
        '{',
        '  public void Charge(Order order)',
        '  {',
        '    _logger.LogInformation("Charging {Id}", order.Id);',
        '  }',
        '}',
      ],
      4,
      'order',
      '    _logger.LogInformation("Charge: order={@Order}", order); // logline',
    ],
    [
      'a.rs',
      ['fn charge(order: &Order) {', '    info!("charging {}", order.id);', '}'],
      0,
      'order',
      '    info!("charge: order={:?}", order); // logline',
    ],
    ['a.rs', ['fn run() {', '    let n = 1;', '}'], 1, 'n', '    eprintln!("run: n={:?}", n); // logline'],
    [
      'a.rb',
      ['def charge(order)', '  card = order.card', 'end'],
      1,
      'card',
      `  puts('charge: card' + " = " + (card).inspect) # logline`,
    ],
    [
      'a.php',
      ['<?php', 'function charge($order) {', '  $this->logger->info("charging", []);', '}'],
      1,
      '$order',
      `  $this->logger->info('charge: $order', ['order' => $order]); // logline`,
    ],
    [
      'a.kt',
      ['fun charge(order: Order) {', '  val x = 1', '}'],
      1,
      'x',
      '  println("charge: x" + " = " + x) // logline',
    ],
    ['a.dart', ['void main() {', '  var x = 1;', '}'], 1, 'x', `  print('main: x' + ' = \${x}'); // logline`],
  ];
  for (const [file, lines, line, expression, expected] of cases) {
    assert.equal(plan(file, lines, line, expression)?.text, expected, file);
  }
  assert.equal(plan('a.c', ['int main() {}'], 0, 'x'), undefined);
});

test('escapes labels so they interpolate and format nothing', () => {
  assert.match(plan('a.py', ['logger.info("a")', 'x = 1'], 1, 'd["%s"]')!.text, /"a: d\[\\"%%s\\"\]=%r", d\["%s"\]\)/);
  assert.match(plan('a.rs', ['let x = 1;'], 0, 'm["{}"]')!.text, /eprintln!\("a: m\[\\"\{\{\}\}\\"\]=\{:\?\}"/);
  assert.match(plan('a.kt', ['val x = 1'], 0, '$x')!.text, /println\("a: \\\$x"/);
  // A backslash is escaped once, so Swift reads `\(` in the label as text, not an interpolation.
  assert.equal(
    plan('a.swift', ['let s = 1'], 0, '"\\(id)"')!.text,
    'print("a: \\"\\\\(id)\\" =", "\\(id)") // logline',
  );
});

test('names the enclosing function, whatever the language', () => {
  assert.equal(enclosingScope(['class A {', '  async load(id: string): Promise<void> {', '    x();'], 2), 'load');
  assert.equal(enclosingScope(['const run = async (a) => {', '  x();'], 1), 'run');
  assert.equal(enclosingScope(['def outer():', '    if x:', '        y()'], 2, 'python'), 'outer');
  assert.equal(enclosingScope(['func (s *S) Serve(w http.ResponseWriter) {', '\tif x {', '\t\ty()'], 2), 'Serve');
  assert.equal(enclosingScope(['if (x) {', '  y();'], 1), undefined);
});

test('finds only lines ending in the marker', () => {
  const text = ['a', '  console.log("x"); // logline', '  y # logline', 'z // loglines', 'w // logline extra'].join(
    '\n',
  );
  assert.deepEqual(insertedLines(text), [1, 2]);
  assert.equal(isInsertedLine('foo(); //logline  '), true);
  assert.deepEqual(insertedLines('nothing here'), []);
});

test('inserted lines are log statements Logline counts', () => {
  const insertion = plan('src/checkout.ts', ['function checkout() {', '  const order = 1;', '}'], 1, 'order')!;
  const [site] = extractLogSites('src/checkout.ts', insertion.text);
  assert.equal(site.literals[0], 'checkout: order');
});

test('reads the value an inserted line logged', () => {
  const pino = JSON.stringify({ level: 20, time: 1, pid: 3, hostname: 'h', order: { id: 42 }, msg: 'checkout: order' });
  assert.equal(loggedValue({ isJson: true, raw: pino }, 'checkout: order'), '{"id":42}');
  assert.equal(
    loggedValue({ message: 'checkout: order { id: 42, total: 129 }' }, 'checkout: order'),
    '{ id: 42, total: 129 }',
  );
  assert.equal(loggedValue({ message: "charge: order={'id': 1}" }, 'charge: order='), "{'id': 1}");
  assert.equal(loggedValue({ message: 'Run: n', fields: { n: 3, level: 'info' } }, 'Run: n'), '3');
  assert.equal(loggedValue({ message: 'x'.repeat(200) }, 'nope', 10), 'xxxxxxxxx…');
  assert.equal(loggedValue({ message: 'checkout: order' }, 'checkout: order'), undefined);
});
