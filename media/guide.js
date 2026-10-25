(() => {
  const api = acquireVsCodeApi();
  const data = window.__LOGLINE_GUIDE__ || {};
  const releases = Array.isArray(data.releases) ? data.releases : [];
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const keys = Array.isArray(data.keys) ? data.keys : [];
  const unread = Number(data.unreadHighlights) || 0;
  const $ = (id) => document.getElementById(id);
  const panels = { guide: $('guideSection'), whatsNew: $('whatsNewSection') };
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let progress = { captured: false, searched: false, shared: false };
  let releasesRendered = false;

  $('guideVersion').textContent = releases[0] ? `Version ${releases[0].version}` : '';
  if (unread) {
    $('whatsNewCount').hidden = false;
    $('whatsNewCount').textContent = String(unread);
  }

  /** The action a card offers: show its control in the Logs panel, run its command, or open its setting. */
  function action(card) {
    const button = element('button', 'card-action', card.target ? 'Show me' : card.command ? 'Try it' : 'Open setting');
    button.type = 'button';
    button.addEventListener('click', () => {
      if (card.target) api.postMessage({ type: 'reveal', target: card.target, fallback: card.fallback });
      else if (card.command) api.postMessage({ type: 'runCommand', command: card.command });
      else api.postMessage({ type: 'openSetting', setting: card.setting });
    });
    return button;
  }

  function renderNav() {
    const links = [
      ['start', 'Get started'],
      ...sections.map((section) => [section.id, section.title, section.isNew]),
      ['keys', 'Keyboard'],
    ];
    $('guideNav').replaceChildren(
      ...links.map(([id, title, isNew]) => {
        const link = element('a', 'nav-link');
        link.href = `#${id}`;
        link.dataset.anchor = id;
        link.append(element('span', '', title));
        if (isNew) link.append(element('span', 'new-badge', 'New'));
        return link;
      }),
    );
  }

  function renderCards() {
    $('guideCards').replaceChildren(
      ...sections.map((section) => {
        const group = element('div', 'guide-group');
        group.id = section.id;
        const heading = element('div', 'group-heading');
        const title = element('h2', '', section.title);
        title.tabIndex = -1;
        heading.append(title);
        if (section.isNew) heading.append(element('span', 'new-badge', 'New'));
        const grid = element('div', 'cards');
        for (const card of cards.filter((item) => item.section === section.id)) {
          const article = element('article', 'card');
          article.dataset.search = [card.title, card.text, card.example, ...(card.where || [])]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          article.append(element('h3', '', card.title));
          const where = element('p', 'where');
          where.setAttribute('aria-label', `Where: ${(card.where || []).join(', ')}`);
          (card.where || []).forEach((part, index) => {
            if (index) where.append(element('span', 'where-arrow', '›'));
            where.append(element('span', 'chip', part));
          });
          article.append(where, element('p', 'text', card.text));
          if (card.example) article.append(element('code', '', card.example));
          const footer = element('div', 'card-footer');
          if (card.target || card.command || card.setting) footer.append(action(card));
          if (card.docs) {
            const docs = element('button', 'link', 'Details in the docs');
            docs.type = 'button';
            docs.addEventListener('click', () => api.postMessage({ type: 'openDocs', anchor: card.docs }));
            footer.append(docs);
          }
          if (footer.childElementCount) article.append(footer);
          grid.append(article);
        }
        group.append(heading, element('p', 'summary', section.summary), grid);
        return group;
      }),
    );
    $('keyList').replaceChildren(
      ...keys.flatMap(([keyText, actionText]) => [element('dt', '', keyText), element('dd', '', actionText)]),
    );
  }

  function renderSteps() {
    const steps = [
      {
        done: progress.captured,
        title: 'Capture a run',
        text: 'Turn on Capture in the status bar, then run your app in a terminal as usual.',
        target: 'captureToggle',
      },
      {
        done: progress.searched,
        title: 'Search it',
        text: 'Type level:error in the search box and press Enter. Click a row to see its details.',
        target: 'search',
      },
      {
        done: progress.shared,
        title: 'Share with an agent',
        text: 'Let Copilot, Claude Code, or Codex read what you captured, redacted and read-only.',
        target: 'shareAgent',
      },
    ];
    $('startSteps').replaceChildren(
      ...steps.map((step, index) => {
        const item = element('li', `step${step.done ? ' done' : ''}`);
        const head = element('div', 'step-head');
        const badge = element('span', 'step-badge', step.done ? '✓' : String(index + 1));
        badge.setAttribute('aria-hidden', 'true');
        head.append(badge, element('strong', '', step.title));
        item.append(head, element('p', 'text', step.text));
        if (step.done) item.append(element('span', 'step-done', 'Done'));
        else {
          const show = element('button', 'card-action primary', 'Show me');
          show.type = 'button';
          show.addEventListener('click', () => api.postMessage({ type: 'reveal', target: step.target }));
          item.append(show);
        }
        item.setAttribute('aria-label', `Step ${index + 1}: ${step.title}${step.done ? ', done' : ''}`);
        return item;
      }),
    );
  }

  function renderReleases() {
    if (releasesRendered) return;
    releasesRendered = true;
    const list = $('releaseList');
    if (!releases.length) {
      list.replaceChildren(element('p', 'summary', 'Release highlights will appear here.'));
      return;
    }
    const [latest, ...earlier] = releases;
    $('whatsNewEyebrow').textContent = unread ? 'New since you last looked' : 'Latest release';
    $('whatsNewTitle').textContent = `Logline ${latest.version}`;
    const hero = element('div', 'highlights');
    for (const highlight of latest.highlights || []) {
      const item = element('article', 'card highlight');
      item.append(element('h3', '', highlight.title), element('p', 'text', highlight.text));
      if (highlight.section) {
        const link = element('button', 'link', 'In the guide');
        link.type = 'button';
        link.dataset.section = 'guide';
        link.dataset.anchor = highlight.section;
        item.append(link);
      }
      hero.append(item);
    }
    const older = element('div', 'earlier');
    if (earlier.length) older.append(element('h2', '', 'Earlier releases'));
    for (const release of earlier) {
      const row = element('section', 'release');
      const label = element('div', 'release-label');
      label.append(element('strong', '', release.version), element('span', 'release-date', release.date));
      const items = element('ul');
      for (const highlight of release.highlights || []) {
        const entry = element('li');
        entry.append(element('strong', '', `${highlight.title}. `), document.createTextNode(highlight.text));
        items.append(entry);
      }
      row.append(label, items);
      older.append(row);
    }
    list.replaceChildren(hero, older);
  }

  function filter(text) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const card of document.querySelectorAll('.card[data-search]')) {
      const match = words.every((word) => card.dataset.search.includes(word));
      card.hidden = !match;
      if (match) shown++;
    }
    for (const group of document.querySelectorAll('#guideCards .guide-group'))
      group.hidden = !group.querySelector('.card:not([hidden])');
    $('start').hidden = words.length > 0;
    $('keys').hidden = words.length > 0;
    $('noResults').hidden = !words.length || shown > 0;
  }

  // A section marked New stops being new once it is opened: chosen in the sidebar, or read
  // for a moment in place. The host remembers it for this release.
  const seen = new Set();
  function markSeen(id) {
    const section = sections.find((item) => item.id === id);
    if (!section || !section.isNew || seen.has(id)) return;
    seen.add(id);
    for (const badge of document.querySelectorAll(`[data-anchor="${id}"] .new-badge, #${id} .group-heading .new-badge`))
      badge.remove();
    api.postMessage({ type: 'sectionSeen', section: id });
  }
  function watchNewSections() {
    if (typeof IntersectionObserver !== 'function') return;
    const timers = new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          // Read in place: it fills most of the window, or all of itself when it is shorter.
          const needed = Math.min(entry.boundingClientRect.height, window.innerHeight) * 0.6;
          if (entry.isIntersecting && entry.intersectionRect.height >= needed) {
            if (!timers.has(id))
              timers.set(
                id,
                setTimeout(() => markSeen(id), 1500),
              );
          } else {
            clearTimeout(timers.get(id));
            timers.delete(id);
          }
        }
      },
      { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] },
    );
    for (const section of sections) if (section.isNew && $(section.id)) observer.observe($(section.id));
  }

  function focusAnchor(anchor) {
    const target = $(anchor);
    const heading = target && target.querySelector('h1, h2');
    if (!target || !heading) return;
    // Keep the heading in the reading order after a jump.
    setTimeout(() => {
      target.scrollIntoView({ block: 'start' });
      heading.focus({ preventScroll: true });
    }, 0);
  }

  function selectSection(section, anchor) {
    const selected = section === 'whatsNew' ? 'whatsNew' : 'guide';
    for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== selected;
    $('whatsNewTab').setAttribute('aria-current', String(selected === 'whatsNew'));
    if (selected === 'whatsNew') {
      renderReleases();
      // The host acknowledges a release only after this section is visible.
      api.postMessage({ type: 'guideRendered', section: 'whatsNew' });
    } else if (anchor) focusAnchor(anchor);
  }

  document.addEventListener('click', (event) => {
    const source = event.target;
    const target =
      source && typeof source.closest === 'function' ? source.closest('[data-anchor], [data-section]') : null;
    if (!target) return;
    event.preventDefault();
    if (target.dataset.section === 'whatsNew') selectSection('whatsNew');
    else {
      selectSection('guide', target.dataset.anchor);
      if (target.dataset.anchor) markSeen(target.dataset.anchor);
    }
  });
  $('guideSearch').addEventListener('input', (event) => {
    selectSection('guide');
    filter(event.target.value);
  });
  $('openChangelog').addEventListener('click', () => api.postMessage({ type: 'openChangelog' }));
  $('takeTour').addEventListener('click', () => api.postMessage({ type: 'takeTour' }));
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'selectSection') selectSection(message.section);
    else if (message?.type === 'guideProgress') {
      progress = { ...progress, ...message.progress };
      renderSteps();
    }
  });

  renderNav();
  renderCards();
  renderSteps();
  watchNewSections();
  api.postMessage({ type: 'guideReady' });
})();
