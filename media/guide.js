(() => {
  const api = acquireVsCodeApi();
  const tabs = [...document.querySelectorAll('.tab')];
  const panels = {
    guide: document.getElementById('guideSection'),
    whatsNew: document.getElementById('whatsNewSection')
  };
  const releases = Array.isArray(window.__LOGLINE_RELEASES__) ? window.__LOGLINE_RELEASES__ : [];
  const releaseList = document.getElementById('releaseList');

  function renderReleases() {
    if (!releaseList) return;
    releaseList.replaceChildren();
    if (!releases.length) {
      const empty = document.createElement('p');
      empty.textContent = 'Release highlights will appear here.';
      releaseList.append(empty);
      return;
    }
    releases.forEach(release => {
      const article = document.createElement('article');
      article.className = 'release';
      const header = document.createElement('div');
      header.className = 'release-header';
      const title = document.createElement('h3');
      title.textContent = `Version ${release.version}`;
      const date = document.createElement('span');
      date.className = 'release-date';
      date.textContent = release.date;
      header.append(title, date);
      const highlights = document.createElement('div');
      highlights.className = 'highlights';
      (Array.isArray(release.highlights) ? release.highlights : []).forEach(highlight => {
        const item = document.createElement('div');
        item.className = 'highlight';
        const heading = document.createElement('h4');
        heading.textContent = highlight.title;
        const text = document.createElement('p');
        text.textContent = highlight.text;
        item.append(heading, text);
        if (highlight.section) {
          const link = document.createElement('button');
          link.type = 'button';
          link.textContent = 'See it in the guide →';
          link.dataset.section = 'guide';
          link.dataset.anchor = highlight.section;
          item.append(link);
        }
        highlights.append(item);
      });
      article.append(header, highlights);
      releaseList.append(article);
    });
  }

  function focusGuideAnchor(anchor) {
    const target = document.getElementById(anchor);
    const heading = target?.querySelector('h2');
    if (!target || !heading) return;
    // Keep the heading in the reading order after a release highlight jump.
    setTimeout(() => {
      target.scrollIntoView({ block: 'start' });
      heading.focus({ preventScroll: true });
    }, 0);
  }

  function selectSection(section, anchor) {
    const selected = section === 'whatsNew' ? 'whatsNew' : 'guide';
    tabs.forEach(tab => {
      const active = tab.dataset.section === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    Object.entries(panels).forEach(([name, panel]) => { panel.hidden = name !== selected; });
    if (selected === 'whatsNew') {
      renderReleases();
      // The host acknowledges a release only after this section is visible.
      api.postMessage({ type: 'guideRendered', section: 'whatsNew' });
    } else if (anchor) focusGuideAnchor(anchor);
  }

  tabs.forEach(tab => tab.addEventListener('click', event => {
    event.preventDefault();
    selectSection(tab.dataset.section);
  }));
  document.addEventListener('click', event => {
    const source = event.target;
    const target = source && typeof source.closest === 'function' ? source.closest('[data-anchor]') : null;
    if (!target) return;
    event.preventDefault();
    selectSection(target.dataset.section, target.dataset.anchor);
  });
  tabs.forEach((tab, index) => tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    selectSection(tabs[next].dataset.section);
  }));
  document.getElementById('openChangelog')?.addEventListener('click', () => api.postMessage({ type: 'openChangelog' }));
  window.addEventListener('message', event => {
    if (event.data?.type === 'selectSection') selectSection(event.data.section);
  });
  api.postMessage({ type: 'guideReady' });
})();
