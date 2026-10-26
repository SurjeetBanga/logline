import {
  applyUrl,
  CONNECTION_TYPES,
  draftSecretKey,
  draftUrl,
  emptyDraft,
  readDraft,
  ROLE_LABELS,
  suggestedLabel,
  suggestsIam,
  withoutPassword,
  type DraftField,
  type FormDraft,
  type FormProfile,
  type FormRequest,
  type FormUpdate,
  type SampleRow,
} from '../../core/connection-form';
import {
  mongoUrl,
  MAPPED_FIELDS,
  type ColumnInfo,
  type ConnectionType,
  type LogTableMapping,
  type MappedField,
} from '../../core/connections';

export interface FormApi {
  postMessage(message: FormRequest): void;
}

type TestState =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; detail: string; tables?: string[] }
  | { state: 'failed'; error: string }
  /** The fields changed since a good test. */
  | { state: 'stale' };

type Child = Node | string | false | undefined | null;

/** An element with attributes, properties starting `on` as listeners, and children. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function')
      element.addEventListener(key.slice(2), value as EventListener);
    else if (key === 'className') element.className = String(value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'hidden')
      (element as unknown as Record<string, unknown>)[key] = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children)
    if (child !== undefined && child !== null && child !== false)
      element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return element;
}

const SERVER_TYPES: ConnectionType[] = ['postgres', 'mysql'];

/**
 * The Connection form: one page that shows what to connect, a log service or
 * a database, how to sign in, a test, which table holds logs if a database has
 * one, with a preview of its rows, and a name.
 * Later steps open once the earlier ones are done, and nothing typed is lost
 * when a test fails.
 */
export function createConnectionForm(api: FormApi, root: HTMLElement) {
  let mode: 'add' | 'edit' = 'add';
  let draft: FormDraft = emptyDraft();
  let secretSaved = false;
  /** Where the saved secret is kept: it is used only while the draft would keep its own there too. */
  let secretFor: string | undefined;
  let profiles: FormProfile[] = [];
  let sites: string[] = [];
  /** Postgres and MySQL are typed as a URL or as separate fields. */
  let entry: 'url' | 'fields' = 'url';
  let urlText = '';
  /** The URL typed does not parse, so the draft still holds the last one that did: no test until it does. */
  let urlInvalid = false;
  let labelEdited = false;
  let showErrors = false;
  const touched = new Set<DraftField>();
  let test: TestState = { state: 'idle' };
  /** The chosen table, null for none, undefined before a choice. */
  let table: string | null | undefined;
  let columns: ColumnInfo[] = [];
  let rows: SampleRow[] = [];
  let columnsState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  let columnsError = '';
  /** Why the preview rows could not be read, when the columns could. */
  let previewError = '';
  let mapping: Partial<Record<MappedField, string>> = {};
  /** When editing, the saved mapping, chosen again once its table is listed. */
  let savedMapping: LogTableMapping | undefined;
  let saving = false;
  let saveError = '';
  /** The draft a running test was sent, to tell whether it changed before the answer came. */
  let testing = '';
  /** What a test covers: everything but the name. */
  const tested = () => JSON.stringify({ ...draft, label: '' });

  const title = h('h1', {}, 'Add connection');
  const lead = h(
    'p',
    { className: 'lead' },
    'Search a log service next to your local runs, or query a database. Every connection is read-only, and passwords and keys stay in VS Code secret storage.',
  );
  const types = h('div', { className: 'type-groups', role: 'radiogroup', 'aria-label': 'What to connect' });
  const details = h('div', { className: 'details' });
  const testButton = h(
    'button',
    { type: 'button', className: 'secondary', onclick: () => runTest() },
    'Test connection',
  );
  const testStatus = h('div', { className: 'test-status', role: 'status', 'aria-live': 'polite' });
  const logs = h('div', { className: 'logs' });
  const labelInput = h('input', {
    id: 'field-label',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    oninput: () => {
      draft.label = labelInput.value;
      labelEdited = true;
      updateFooter();
    },
  });
  const saveButton = h('button', { type: 'button', onclick: () => save() }, 'Add connection');
  const cancelButton = h(
    'button',
    { type: 'button', className: 'secondary', onclick: () => api.postMessage({ type: 'cancel' }) },
    'Cancel',
  );
  const footerNote = h('span', { className: 'footer-note', role: 'status', 'aria-live': 'polite' });

  const step = (number: number, heading: Child, ...children: Child[]) =>
    h(
      'section',
      { className: 'step' },
      h('h2', {}, h('span', { className: 'step-number', 'aria-hidden': 'true' }, String(number)), heading),
      ...children,
    );
  /** Step 3 is Logs for a log service, and an optional log table for a database. */
  const logsHeading = h('span', {}, 'Logs');
  const typeStep = step(1, 'What are you connecting?', types);
  const connectStep = step(2, 'Connect', details, h('div', { className: 'test-row' }, testButton, testStatus));
  const logsStep = step(3, logsHeading, logs);
  const nameStep = step(
    4,
    'Name',
    h('div', { className: 'field' }, h('label', { for: 'field-label' }, 'Shown in the Sources list'), labelInput),
  );
  root.replaceChildren(
    h(
      'main',
      { className: 'form' },
      h('header', {}, title, lead),
      typeStep,
      connectStep,
      logsStep,
      nameStep,
      h('footer', {}, footerNote, h('div', { className: 'buttons' }, cancelButton, saveButton)),
    ),
  );

  // ---- What the draft says, and what is wrong with it.

  function result() {
    return readDraft(draft, { secret: keepsSecret() });
  }

  /** Whether an empty password or key field keeps the saved one: not once the edit points elsewhere. */
  function keepsSecret(): boolean {
    return secretSaved && !draft.forgetSecret && draftSecretKey(draft) === secretFor;
  }

  function secretPlaceholder(): string {
    return keepsSecret() ? 'Saved · leave empty to keep' : '';
  }

  /** The draft changed: a good test no longer covers it, so the later steps wait for a new one. */
  function changed(field?: DraftField): void {
    if (field) touched.add(field);
    if (test.state === 'ok' || test.state === 'failed') test = { state: 'stale' };
    if (!labelEdited) {
      draft.label = suggestedLabel(draft);
      labelInput.value = draft.label;
    }
    saveError = '';
    const placeholder = secretPlaceholder();
    for (const name of ['password', 'apiKey', 'appKey', 'token'])
      details.querySelector(`#field-${name}`)?.setAttribute('placeholder', placeholder);
    updateErrors();
    updateTest();
    renderLogs();
    updateFooter();
  }

  function updateErrors(): void {
    // Read once for every field: each keystroke lands here.
    const { errors } = result();
    for (const node of details.querySelectorAll<HTMLElement>('[data-error-for]')) {
      const field = node.dataset.errorFor as DraftField;
      const message = showErrors || touched.has(field) ? errors[field] : undefined;
      node.textContent = message ?? '';
      node.hidden = !message;
      const input = details.querySelector<HTMLElement>(`#field-${node.dataset.errorFor}`);
      input?.setAttribute('aria-invalid', String(Boolean(message)));
    }
  }

  // ---- Inputs.

  function field(
    name: DraftField,
    label: string,
    options: {
      type?: string;
      placeholder?: string;
      hint?: Child;
      wide?: boolean;
      inputMode?: string;
      onInput?: (value: string) => void;
    } = {},
  ): HTMLElement {
    const input = h('input', {
      id: `field-${name}`,
      type: options.type ?? 'text',
      value: String(draft[name] ?? ''),
      placeholder: options.placeholder,
      spellcheck: 'false',
      autocomplete: options.type === 'password' ? 'new-password' : 'off',
      inputmode: options.inputMode,
      'aria-describedby': `error-${name}`,
      oninput: () => {
        if (options.onInput) options.onInput(input.value);
        else (draft as unknown as Record<string, unknown>)[name] = input.value;
        changed();
      },
      onblur: () => {
        touched.add(name);
        updateErrors();
      },
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter') runTest();
      },
    });
    return h(
      'div',
      { className: `field${options.wide ? ' wide' : ''}` },
      h('label', { for: `field-${name}` }, label),
      input,
      options.hint ? h('div', { className: 'hint' }, options.hint) : undefined,
      h('div', { className: 'error', id: `error-${name}`, 'data-error-for': name, hidden: true }),
    );
  }

  function secretField(name: 'password' | 'apiKey' | 'appKey' | 'token', label: string, hint?: string): HTMLElement {
    const element = field(name, label, {
      type: 'password',
      placeholder: secretPlaceholder() || undefined,
      hint: hint ?? 'Kept in VS Code secret storage, never in settings.',
    });
    // A saved password can be dropped, such as for a server that no longer needs one; keys are always needed.
    if (name === 'password' && mode === 'edit' && secretSaved)
      element.append(
        h(
          'label',
          { className: 'check' },
          h('input', {
            type: 'checkbox',
            id: 'field-forgetSecret',
            checked: draft.forgetSecret,
            onchange: (event: Event) => {
              draft.forgetSecret = (event.target as HTMLInputElement).checked;
              changed();
            },
          }),
          'Forget the saved password',
        ),
      );
    return element;
  }

  function choice<T extends string>(
    name: string,
    label: string,
    value: T,
    options: { value: T; label: string; hint?: string }[],
    onChange: (value: T) => void,
  ): HTMLElement {
    return h(
      'fieldset',
      { className: 'choice' },
      h('legend', {}, label),
      h(
        'div',
        { className: 'segmented' },
        ...options.map((option) =>
          h(
            'label',
            { className: `segment${option.value === value ? ' selected' : ''}`, title: option.hint },
            h('input', {
              type: 'radio',
              name,
              value: option.value,
              checked: option.value === value,
              onchange: () => onChange(option.value),
            }),
            option.label,
          ),
        ),
      ),
    );
  }

  // ---- Step 1: the type.

  function renderTypes(): void {
    const group = (kind: 'logs' | 'database', caption: string) =>
      h(
        'div',
        { className: `type-group ${kind === 'logs' ? 'service' : 'database'}` },
        h('div', { className: 'type-caption' }, caption),
        h('div', { className: 'type-grid' }, ...cards(kind)),
      );
    types.replaceChildren(group('logs', 'Log service'), group('database', 'Database to query'));
  }

  function cards(kind: 'logs' | 'database'): HTMLElement[] {
    return CONNECTION_TYPES.filter((entryType) => entryType.kind === kind).map((entryType) => {
      const selected = entryType.type === draft.type;
      return h(
        'label',
        {
          className: `type-card${selected ? ' selected' : ''}${mode === 'edit' && !selected ? ' disabled' : ''}`,
        },
        h('input', {
          type: 'radio',
          name: 'type',
          value: entryType.type,
          checked: selected,
          disabled: mode === 'edit' && !selected,
          onchange: () => chooseType(entryType.type),
        }),
        h('span', { className: 'type-name' }, entryType.label),
        h('span', { className: 'type-description' }, entryType.description),
      );
    });
  }

  function chooseType(type: ConnectionType): void {
    if (type === draft.type) return;
    // What was typed for the server stays when switching between Postgres and MySQL.
    const keep = SERVER_TYPES.includes(type) && SERVER_TYPES.includes(draft.type);
    const next = emptyDraft(type);
    draft = keep
      ? {
          ...draft,
          type,
          port: draft.port === emptyDraft(draft.type).port ? next.port : draft.port,
        }
      : { ...next, label: labelEdited ? draft.label : '' };
    urlText = keep && entry === 'url' ? draftUrl(draft) : '';
    urlInvalid = false;
    touched.clear();
    showErrors = false;
    test = { state: 'idle' };
    table = undefined;
    renderTypes();
    renderDetails();
    changed();
  }

  // ---- Step 2: how to connect.

  function renderDetails(): void {
    const children: Child[] = [];
    switch (draft.type) {
      case 'postgres':
      case 'mysql':
        children.push(...serverDetails());
        break;
      case 'mongodb':
        children.push(...mongoDetails());
        break;
      case 'sqlite':
        children.push(...sqliteDetails());
        break;
      case 'datadog':
        children.push(...datadogDetails());
        break;
    }
    details.replaceChildren(...children.filter((child): child is Node | string => !!child));
    updateErrors();
  }

  function serverDetails(): Child[] {
    const name = draft.type === 'mysql' ? 'MySQL' : 'Postgres';
    const example =
      draft.type === 'mysql' ? 'mysql://user@db.example.com:3306/app' : 'postgres://user@db.example.com:5432/app';
    const urlPreview = h('code', { className: 'url-preview' }, draftUrl(draft) || '—');
    const iamHint = h(
      'div',
      { className: 'hint callout', hidden: !(suggestsIam(draft) && draft.auth === 'password') },
      'This is an Amazon RDS or Aurora host: it can sign in with an AWS IAM token instead of a password.',
    );
    const refresh = () => {
      urlPreview.textContent = draftUrl(draft) || '—';
      iamHint.hidden = !(suggestsIam(draft) && draft.auth === 'password');
    };
    const urlError = h('div', { className: 'error', id: 'error-url-entry', hidden: true });
    const urlInput = h('input', {
      id: 'field-url-entry',
      type: 'text',
      value: urlText || draftUrl(draft),
      placeholder: example,
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-describedby': 'error-url-entry',
      oninput: () => {
        urlText = urlInput.value;
        const next = applyUrl(draft, urlInput.value);
        urlInvalid = !next;
        urlError.hidden = !!next || !urlInput.value.trim();
        urlError.textContent = next ? '' : `Enter a URL such as ${example}`;
        if (next) {
          const movedPassword = next.password !== draft.password;
          draft = next;
          // A password pasted with the URL moves to its own field and out of the URL.
          if (movedPassword) {
            const password = details.querySelector<HTMLInputElement>('#field-password');
            if (password) password.value = draft.password;
            urlInput.value = urlText = withoutPassword(urlInput.value);
          }
        }
        refresh();
        changed();
      },
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter') runTest();
      },
    });
    const connection =
      entry === 'url'
        ? h(
            'div',
            { className: 'field wide' },
            h('label', { for: 'field-url-entry' }, `${name} URL`),
            urlInput,
            h('div', { className: 'hint' }, 'A password in the URL moves to the password field below.'),
            urlError,
          )
        : h(
            'div',
            { className: 'grid server' },
            field('host', 'Host', { placeholder: 'db.example.com', onInput: (value) => set('host', value) }),
            field('port', 'Port', { inputMode: 'numeric', onInput: (value) => set('port', value) }),
            field('database', 'Database', { onInput: (value) => set('database', value) }),
            field('user', 'User', { onInput: (value) => set('user', value) }),
            h(
              'label',
              { className: 'check wide' },
              h('input', {
                type: 'checkbox',
                checked: draft.ssl || draft.auth === 'iam',
                disabled: draft.auth === 'iam',
                onchange: (event: Event) => {
                  draft.ssl = (event.target as HTMLInputElement).checked;
                  refresh();
                  changed();
                },
              }),
              'Require TLS, checking the server’s certificate',
            ),
            h('div', { className: 'wide hint' }, 'URL: ', urlPreview),
          );
    function set(key: 'host' | 'port' | 'user' | 'database', value: string) {
      draft[key] = value;
      refresh();
    }
    const auth =
      draft.auth === 'iam'
        ? h(
            'div',
            { className: 'field' },
            h('label', { for: 'field-profile' }, 'AWS profile that signs the token'),
            h(
              'select',
              {
                id: 'field-profile',
                onchange: (event: Event) => {
                  draft.profile = (event.target as HTMLSelectElement).value;
                  changed();
                },
              },
              h('option', { value: '' }, 'Default credentials (environment, AWS_PROFILE, or default)'),
              ...profiles.map((profile) =>
                h(
                  'option',
                  { value: profile.name, ...(profile.name === draft.profile ? { selected: true } : {}) },
                  profile.description ? `${profile.name} · ${profile.description}` : profile.name,
                ),
              ),
            ),
            h(
              'div',
              { className: 'hint' },
              'A 15-minute token is made for each connection, so no password is stored. TLS is required.',
            ),
          )
        : secretField(
            'password',
            'Password',
            'Leave empty if the server needs none. Kept in VS Code secret storage, never in settings.',
          );
    return [
      choice(
        'entry',
        'Enter the server as',
        entry,
        [
          { value: 'url', label: 'URL' },
          { value: 'fields', label: 'Fields' },
        ],
        (value) => {
          entry = value;
          urlText = '';
          urlInvalid = false;
          renderDetails();
        },
      ),
      connection,
      iamHint,
      choice(
        'auth',
        'Sign in with',
        draft.auth,
        [
          { value: 'password', label: 'Password' },
          { value: 'iam', label: 'AWS IAM token', hint: 'For Amazon RDS and Aurora' },
        ],
        (value) => {
          draft.auth = value;
          renderDetails();
          changed();
        },
      ),
      auth,
    ];
  }

  function mongoDetails(): Child[] {
    const password = secretField('password', 'Password');
    // A database of its own is asked for only when the URL does not end with one, or one was saved apart from it.
    const database = field('database', 'Database', {
      hint: 'The database the logs are in. The URL does not name one, or only names where to sign in.',
    });
    const refresh = () => {
      password.hidden = !mongoUrl(draft.url)?.user;
      database.hidden = !!mongoUrl(draft.url)?.database && !draft.database.trim();
    };
    refresh();
    return [
      field('url', 'MongoDB URL', {
        placeholder: 'mongodb+srv://reader@cluster0.example.net/app',
        wide: true,
        hint: 'A password in the URL moves to the password field, so the saved URL never holds one.',
        onInput: (value) => {
          const next = applyUrl(draft, value);
          if (next) {
            const movedPassword = next.password !== draft.password;
            draft = next;
            const input = details.querySelector<HTMLInputElement>('#field-url');
            // Show the URL without the password the moment it moves out.
            if (input && movedPassword) input.value = draft.url;
            const passwordInput = details.querySelector<HTMLInputElement>('#field-password');
            if (passwordInput && movedPassword) passwordInput.value = draft.password;
          } else draft.url = value;
          refresh();
        },
      }),
      database,
      password,
    ];
  }

  let outsideWorkspace = false;
  function sqliteDetails(): Child[] {
    return [
      h(
        'div',
        { className: 'field wide' },
        h('label', { for: 'field-path' }, 'Database file'),
        h(
          'div',
          { className: 'inline' },
          h('input', {
            id: 'field-path',
            type: 'text',
            value: draft.path,
            placeholder: 'logs/app.db',
            spellcheck: 'false',
            'aria-describedby': 'error-path',
            oninput: (event: Event) => {
              draft.path = (event.target as HTMLInputElement).value;
              outsideWorkspace = false;
              changed('path');
            },
            onkeydown: (event: KeyboardEvent) => {
              if (event.key === 'Enter') runTest();
            },
          }),
          h(
            'button',
            { type: 'button', className: 'secondary', onclick: () => api.postMessage({ type: 'browse' }) },
            'Browse…',
          ),
        ),
        h(
          'div',
          { className: 'hint' },
          outsideWorkspace
            ? 'This file is outside the workspace, so its full path is saved and the setting only works on this machine.'
            : 'A file inside the workspace is saved relative to it, so the setting works on every clone. It is opened read-only.',
        ),
        h('div', { className: 'error', id: 'error-path', 'data-error-for': 'path', hidden: true }),
      ),
    ];
  }

  function datadogDetails(): Child[] {
    const other = !sites.includes(draft.site);
    const siteSelect = h(
      'select',
      {
        id: 'field-site-choice',
        onchange: () => {
          draft.site = siteSelect.value === 'other' ? '' : siteSelect.value;
          renderDetails();
          changed();
        },
      },
      ...sites.map((site) =>
        h(
          'option',
          { value: site, ...(site === draft.site ? { selected: true } : {}) },
          site === 'datadoghq.com' ? `${site} (US1)` : site,
        ),
      ),
      h('option', { value: 'other', ...(other ? { selected: true } : {}) }, 'Other: an API URL, such as a proxy'),
    );
    return [
      h(
        'div',
        { className: 'grid' },
        h(
          'div',
          { className: 'field' },
          h('label', { for: 'field-site-choice' }, 'Site'),
          siteSelect,
          h('div', { className: 'hint' }, 'The domain of your Datadog web app.'),
        ),
        other ? field('site', 'API URL', { placeholder: 'https://datadog-proxy.example.com' }) : undefined,
      ),
      choice(
        'keyKind',
        'Sign in with',
        draft.keyKind,
        [
          { value: 'keys', label: 'API and application keys' },
          { value: 'token', label: 'Access token' },
        ],
        (value) => {
          draft.keyKind = value;
          renderDetails();
          changed();
        },
      ),
      draft.keyKind === 'token'
        ? h('div', { className: 'grid' }, secretField('token', 'Access token'))
        : h(
            'div',
            { className: 'grid' },
            secretField('apiKey', 'API key', 'Organization Settings › API Keys.'),
            secretField('appKey', 'Application key', 'Organization Settings › Application Keys.'),
          ),
      h(
        'div',
        { className: 'hint' },
        'They need the logs_read_data permission, and are kept in VS Code secret storage, never in settings.',
      ),
    ];
  }

  // ---- The test.

  function runTest(): void {
    if (test.state === 'running') return;
    showErrors = true;
    updateErrors();
    if (entry === 'url' && urlInvalid && SERVER_TYPES.includes(draft.type)) {
      details.querySelector<HTMLElement>('#field-url-entry')?.focus();
      test = { state: 'failed', error: 'Enter a URL Logline can read, or use Fields.' };
      updateTest();
      return;
    }
    const { connection, errors } = result();
    if (!connection) {
      const first = Object.keys(errors)[0];
      details.querySelector<HTMLElement>(`#field-${first}`)?.focus();
      test = { state: 'failed', error: Object.values(errors)[0] ?? 'Fill in the connection first.' };
      updateTest();
      return;
    }
    test = { state: 'running' };
    testing = tested();
    updateTest();
    updateFooter();
    api.postMessage({ type: 'test', draft });
  }

  function updateTest(): void {
    testButton.disabled = test.state === 'running';
    testButton.textContent =
      test.state === 'running' ? 'Testing…' : test.state === 'ok' ? 'Test again' : 'Test connection';
    testStatus.className = `test-status ${test.state}`;
    testStatus.textContent =
      test.state === 'running'
        ? 'Connecting…'
        : test.state === 'ok'
          ? `✓ Connected · ${test.detail}`
          : test.state === 'failed'
            ? test.error
            : test.state === 'stale'
              ? 'Changed since the last test. Test again to continue.'
              : '';
  }

  // ---- Step 3: the log table and its columns.

  function renderLogs(): void {
    const isDatadog = draft.type === 'datadog';
    const ready = test.state === 'ok';
    logsStep.classList.toggle('locked', !ready);
    nameStep.classList.toggle('locked', !ready);
    labelInput.disabled = !ready;
    const word = draft.type === 'mongodb' ? 'collection' : 'table';
    logsHeading.textContent = isDatadog ? 'Logs' : `Log ${word}`;
    if (isDatadog) {
      logs.replaceChildren(
        h(
          'p',
          { className: 'hint' },
          ready
            ? 'Datadog logs need no table. Searches use Datadog’s own fields: service, host, status, and @attributes.'
            : 'Test the connection first.',
        ),
      );
      return;
    }
    if (!ready || test.state !== 'ok') {
      logs.replaceChildren(h('p', { className: 'hint' }, 'Test the connection to list its tables.'));
      return;
    }
    const query = draft.type === 'mongodb' ? 'queries' : 'SQL';
    const tables = test.tables ?? [];
    const select = h(
      'select',
      {
        id: 'field-table',
        onchange: () => chooseTable(select.value === '\0none' ? null : select.value || undefined),
      },
      table === undefined ? h('option', { value: '', selected: true }, `Choose a ${word}…`) : undefined,
      h(
        'option',
        { value: '\0none', ...(table === null ? { selected: true } : {}) },
        `None: only run ${query} you type`,
      ),
      ...tables.map((name) => h('option', { value: name, ...(name === table ? { selected: true } : {}) }, name)),
    );
    const children: Child[] = [
      h(
        'div',
        { className: 'field' },
        h(
          'label',
          { for: 'field-table' },
          h('span', {}, `Log ${word}`),
          h('span', { className: 'required' }, ' optional'),
        ),
        select,
        h(
          'div',
          { className: 'hint' },
          tables.length
            ? `The connection runs the ${query} you type. If a ${word} holds one ${draft.type === 'mongodb' ? 'document' : 'row'} per log event, choose it to also search and tail it like logs.`
            : `This database has no ${word}s Logline can read; it can still run the ${query} you type.`,
        ),
      ),
    ];
    if (table) {
      if (columnsState === 'loading') children.push(h('p', { className: 'hint' }, `Reading ${table}…`));
      else if (columnsState === 'failed') children.push(h('p', { className: 'error' }, columnsError));
      else if (columnsState === 'ready') children.push(mappingGrid(), preview());
    }
    logs.replaceChildren(...children.filter((child): child is Node => !!child && typeof child !== 'string'));
  }

  function chooseTable(next: string | null | undefined): void {
    table = next;
    columns = [];
    rows = [];
    previewError = '';
    mapping = {};
    columnsState = next ? 'loading' : 'idle';
    if (next) api.postMessage({ type: 'table', table: next });
    renderLogs();
    updateFooter();
  }

  function sampleOf(column: string | undefined): string {
    if (!column) return '';
    return rows.find((row) => row[column])?.[column] ?? '';
  }

  function mappingGrid(): HTMLElement {
    return h(
      'div',
      { className: 'mapping', role: 'group', 'aria-label': 'Which column holds what' },
      h(
        'p',
        { className: 'hint' },
        'Logline guessed these from the column names. Every other column becomes a searchable field.',
      ),
      ...MAPPED_FIELDS.map((role) => {
        const id = `map-${role}`;
        const select = h(
          'select',
          {
            id,
            onchange: () => {
              if (select.value) mapping[role] = select.value;
              else delete mapping[role];
              renderLogs();
              updateFooter();
              document.getElementById(id)?.focus();
            },
          },
          h(
            'option',
            { value: '', ...(!mapping[role] ? { selected: true } : {}) },
            role === 'timestamp' ? 'Choose the time column…' : 'None',
          ),
          ...columns.map((column) =>
            h(
              'option',
              { value: column.name, ...(column.name === mapping[role] ? { selected: true } : {}) },
              column.type ? `${column.name}  (${column.type})` : column.name,
            ),
          ),
        );
        return h(
          'div',
          { className: `mapping-row${role === 'timestamp' && !mapping.timestamp ? ' missing' : ''}` },
          h(
            'label',
            { for: id },
            ROLE_LABELS[role],
            role === 'timestamp' ? h('span', { className: 'required' }, ' required') : '',
          ),
          select,
          h('span', { className: 'sample', title: sampleOf(mapping[role]) }, sampleOf(mapping[role])),
        );
      }),
    );
  }

  function preview(): HTMLElement {
    if (previewError) return h('p', { className: 'hint' }, `Could not preview ${table}: ${previewError}`);
    if (!rows.length) return h('p', { className: 'hint' }, `${table} is empty, so there is nothing to preview yet.`);
    const roleOf = new Map(Object.entries(mapping).map(([role, column]) => [column, role as MappedField]));
    const names = columns.length ? columns.map((column) => column.name) : Object.keys(rows[0]);
    return h(
      'div',
      { className: 'preview' },
      h(
        'div',
        { className: 'preview-title' },
        `First ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} of ${table}`,
      ),
      h(
        'div',
        { className: 'preview-scroll', tabindex: '0' },
        h(
          'table',
          {},
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ...names.map((name) => {
                const role = roleOf.get(name);
                return h(
                  'th',
                  { className: role ? 'mapped' : undefined },
                  name,
                  role ? h('span', { className: 'role' }, ROLE_LABELS[role]) : undefined,
                );
              }),
            ),
          ),
          h(
            'tbody',
            {},
            ...rows.map((row) =>
              h(
                'tr',
                {},
                ...names.map((name) =>
                  h(
                    'td',
                    { className: roleOf.has(name) ? 'mapped' : undefined, title: row[name] ?? '' },
                    row[name] ?? '',
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // ---- Saving.

  /** What still stands between the form and Save, or undefined when it can be saved. */
  function missing(): string | undefined {
    if (test.state === 'running') return 'Testing the connection…';
    if (test.state !== 'ok') return 'Test the connection to continue.';
    if (draft.type !== 'datadog') {
      const word = draft.type === 'mongodb' ? 'collection' : 'table';
      if (table === undefined) return `Choose the log ${word}, or None.`;
      if (table && columnsState !== 'ready') return `Reading ${table}…`;
      if (table && !mapping.timestamp) return 'Choose the time column.';
    }
    if (!draft.label.trim()) return 'Give the connection a name.';
    return undefined;
  }

  function updateFooter(): void {
    const blocked = missing();
    saveButton.disabled = saving || !!blocked;
    saveButton.textContent = saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add connection';
    footerNote.className = `footer-note${saveError ? ' error' : ''}`;
    footerNote.textContent = saveError || blocked || '';
  }

  function save(): void {
    if (missing() || saving) return;
    saving = true;
    saveError = '';
    updateFooter();
    const chosen: LogTableMapping | null =
      draft.type === 'datadog' || !table ? null : ({ table, ...mapping } as LogTableMapping);
    api.postMessage({ type: 'save', draft, mapping: chosen });
  }

  // ---- Messages from the extension.

  function receive(update: FormUpdate): void {
    switch (update.type) {
      case 'init':
        mode = update.mode;
        draft = update.draft;
        secretSaved = update.secret;
        secretFor = update.secretKey;
        profiles = update.profiles;
        sites = update.sites;
        savedMapping = update.mapping;
        entry = mode === 'edit' ? 'fields' : 'url';
        // A name typed before the form came back in a new view is kept, not replaced by a suggestion.
        labelEdited = mode === 'edit' || (!!draft.label && draft.label !== suggestedLabel(draft));
        if (!labelEdited) draft.label = suggestedLabel(draft);
        labelInput.value = draft.label;
        title.textContent = mode === 'edit' ? `Edit ${draft.label}` : 'Add connection';
        typeStep.hidden = false;
        renderTypes();
        renderDetails();
        updateTest();
        renderLogs();
        updateFooter();
        // A saved connection is tested straight away, so its tables are there to change.
        if (mode === 'edit' && result().connection) runTest();
        else (details.querySelector('input') as HTMLInputElement | null)?.focus();
        return;
      case 'tested':
        // A field changed while the test ran: its answer is about a connection the form no longer shows.
        test =
          tested() !== testing
            ? { state: 'stale' }
            : update.ok
              ? { state: 'ok', detail: update.detail, tables: update.tables }
              : { state: 'failed', error: update.error };
        updateTest();
        if (test.state === 'ok') {
          const tables = test.tables ?? [];
          // The table chosen before, or the saved one when editing, is chosen again if it is still there.
          // Its columns are read again, since the test may have opened another database, keeping the choices made.
          if (table && mapping.timestamp) savedMapping = { ...mapping, table, timestamp: mapping.timestamp };
          // None chosen by hand stays None; only no choice yet falls back to the saved table.
          const again = table === null ? undefined : (table ?? savedMapping?.table);
          if (again && tables.includes(again)) chooseTable(again);
          else if (table && !tables.includes(table)) chooseTable(undefined);
          // A database needs no log table: unless one was saved, it starts as None.
          else if (table === undefined && !savedMapping && draft.type !== 'datadog') table = null;
        }
        renderLogs();
        updateFooter();
        return;
      case 'columns':
        if (update.table !== table) return;
        if ('error' in update) {
          columnsState = 'failed';
          columnsError = `Could not read ${update.table}: ${update.error}`;
        } else {
          columns = update.columns;
          rows = update.rows;
          previewError = update.previewError ?? '';
          const saved = savedMapping?.table === update.table ? savedMapping : undefined;
          mapping = {};
          for (const role of MAPPED_FIELDS) {
            const column = saved ? saved[role] : update.suggested[role];
            if (column && columns.some((info) => info.name === column)) mapping[role] = column;
          }
          // The saved mapping is used once; choosing the table again starts from the guesses.
          if (saved) savedMapping = undefined;
          columnsState = 'ready';
        }
        renderLogs();
        updateFooter();
        return;
      case 'file':
        draft.path = update.path;
        outsideWorkspace = update.outside;
        renderDetails();
        changed('path');
        return;
      case 'saveFailed':
        saving = false;
        saveError = update.error;
        updateFooter();
        return;
    }
  }

  typeStep.hidden = true;
  updateFooter();
  return { receive };
}
