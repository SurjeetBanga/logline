import type { HostMessage } from '../../protocol/messages';
import { completeQuery } from '../../core/query-completion';
import { queryTokens } from '../../core/query-tokens';
import type { SavedSearch } from '../../storage/saved-searches';
import type { Elements } from '../dom';
import { emptyMessage } from '../dom';
import { EventScope } from '../event-scope';
import type { Popover } from '../popovers';
import type { ViewerState } from '../state';
import { LEVELS } from '../state';
import type { ViewerActions, WebviewApi } from '../types';

export function createSearch(elements: Elements, state: ViewerState, api: WebviewApi, popovers: Popover[], actions: Pick<ViewerActions, 'filterChanged'>, scope: EventScope) {
  const { filterChanged } = actions;
  const MAX_QUERY_LENGTH = 256;
  let appliedQuery = queryTokens(elements.search.value.trim()).map(value => value.toLowerCase() === 'or' ? 'OR' : value).join(' ').slice(0, MAX_QUERY_LENGTH);
  let editingIndex: number | undefined;
  // A checkbox per level (any combination, Kayak-filter style) rather than a
  // single "at least X" choice, so e.g. Info + Error but not Warn is possible.

  const LEVEL_LABELS: Record<string, string> = { trace: 'Trace', debug: 'Debug', info: 'Info', warn: 'Warn', error: 'Error', fatal: 'Fatal', unclassified: 'Unclassified' };

  function tokens(query: string) {
    return queryTokens(query.trim()).map(value => value.toLowerCase() === 'or' ? 'OR' : value);
  }

  function validDraft(input: string, canStartWithOr = Boolean(appliedQuery)): { values: string[]; error?: string; } {
    const value = input.trim();
    if (!value) return { values: [] };
    let escaped = false;
    let quoted = false;
    let brackets = 0;
    for (const character of value) {
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') quoted = !quoted;
      else if (!quoted && character === '[') brackets++;
      else if (!quoted && character === ']') brackets--;
      if (brackets < 0) return { values: [], error: 'Close the filter range before applying it.' };
    }
    if (quoted) return { values: [], error: 'Close the quoted filter before applying it.' };
    if (brackets !== 0) return { values: [], error: 'Close the filter range before applying it.' };
    const values = tokens(value);
    if (!values.length) return { values: [], error: 'Enter a filter term.' };
    if ((values[0] === 'OR' && !canStartWithOr) || values.at(-1) === 'OR' || values.some((item, index) => item === 'OR' && values[index - 1] === 'OR'))
      return { values: [], error: 'OR must have a filter on both sides.' };
    return { values };
  }

  function setError(error?: string) {
    elements.searchError.textContent = error ?? '';
    elements.searchError.hidden = !error;
  }

  function cleanQuery(values: string[]) {
    const cleaned: string[] = [];
    values.forEach((value, index) => {
      if (value === 'OR' && (index === 0 || index === values.length - 1 || values[index - 1] === 'OR')) return;
      cleaned.push(value);
    });
    if (cleaned.at(-1) === 'OR') cleaned.pop();
    if (cleaned[0] === 'OR') cleaned.shift();
    return cleaned;
  }

  function renderChips() {
    const values = tokens(appliedQuery);
    let editingInput: HTMLInputElement | undefined;
    elements.searchChips.replaceChildren(...values.map((value, index) => {
      if (value === 'OR') {
        const separator = document.createElement('span');
        separator.className = 'search-or';
        separator.textContent = 'OR';
        separator.setAttribute('aria-hidden', 'true');
        return separator;
      }
      const chip = document.createElement('span');
      chip.className = `filter-chip${value.startsWith('-') ? ' exclude' : ''}${editingIndex === index ? ' editing' : ''}`;
      chip.title = value;
      if (editingIndex === index) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'filter-chip-input';
        input.value = value;
        input.maxLength = MAX_QUERY_LENGTH;
        input.title = `Edit filter: ${value}`;
        input.setAttribute('aria-label', `Edit filter: ${value}`);
        scope.listen(input, 'input', () => setError());
        scope.listen(input, 'keydown', event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            applyValue(input.value, index);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancelEdit();
          }
        });
        editingInput = input;
        chip.append(input);
      } else {
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'filter-chip-label';
        label.textContent = value;
        label.title = `Edit filter: ${value}`;
        label.setAttribute('aria-label', `Edit filter: ${value}`);
        scope.listen(label, 'click', event => { event.stopPropagation(); beginEdit(index); });
        chip.append(label);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'filter-chip-remove';
      remove.textContent = '×';
      remove.title = `Remove filter: ${value}`;
      remove.setAttribute('aria-label', `Remove filter: ${value}`);
      scope.listen(remove, 'click', event => { event.stopPropagation(); removeAt(index); });
      chip.append(remove);
      return chip;
    }));
    const editorClasses = elements.searchEditor.className.split(' ').filter(Boolean).filter(value => value !== 'has-chips');
    if (values.some(value => value !== 'OR')) editorClasses.push('has-chips');
    elements.searchEditor.className = editorClasses.join(' ');
    elements.searchClear.hidden = values.every(value => value === 'OR');
    if (editingInput) {
      editingInput.focus();
      editingInput.select?.();
    }
  }

  function query() { return appliedQuery; }

  function setQuery(value: string, notify = false) {
    appliedQuery = tokens(value).join(' ').slice(0, MAX_QUERY_LENGTH);
    editingIndex = undefined;
    // Keep the serialized value until focus moves into the editor. This makes
    // the state inspectable to assistive tooling and lets the native input
    // remain a useful fallback while the chips are being rendered.
    elements.search.value = appliedQuery;
    setError();
    clearAutocomplete();
    renderChips();
    if (notify) filterChanged();
  }

  function beginEdit(index: number) {
    editingIndex = index;
    setError();
    renderChips();
  }

  function cancelEdit() {
    editingIndex = undefined;
    setError();
    renderChips();
    elements.search.focus();
  }

  function removeAt(index: number) {
    const values = cleanQuery(tokens(appliedQuery).filter((_, itemIndex) => itemIndex !== index));
    setQuery(values.join(' '), true);
    elements.search.focus();
  }

  function applyValue(value: string, replacingIndex?: number) {
    const result = validDraft(value, replacingIndex === undefined && Boolean(appliedQuery));
    if (result.error) { setError(result.error); return false; }
    if (!result.values.length) return false;
    const current = tokens(appliedQuery);
    const next = replacingIndex === undefined ? [...current, ...result.values]
      : [...current.slice(0, replacingIndex), ...result.values, ...current.slice(replacingIndex + 1)];
    const normalized = cleanQuery(next).join(' ');
    if (normalized.length > MAX_QUERY_LENGTH) {
      setError(`Filters cannot exceed ${MAX_QUERY_LENGTH} characters.`);
      return false;
    }
    setQuery(normalized, true);
    elements.search.value = '';
    return true;
  }

  function applyDraft() { return applyValue(elements.search.value); }

  function clear() {
    if (!appliedQuery && !elements.search.value) return;
    setQuery('', true);
    elements.search.focus();
  }

  function updateLevelButtonLabel() {
    if (state.checkedLevels.size === LEVELS.length)
      elements.levelButton.textContent = 'All levels';
    else if (state.checkedLevels.size === 0)
      elements.levelButton.textContent = 'No levels';
    else if (state.checkedLevels.size === 1)
      elements.levelButton.textContent = `${LEVEL_LABELS[[...state.checkedLevels][0]]} only`;
    else
      elements.levelButton.textContent = `${state.checkedLevels.size} levels`;
  }

  function setAllLevels(value: boolean) {
    state.checkedLevels = value ? new Set(LEVELS) : new Set();
    buildLevelMenu();
    updateLevelButtonLabel();
    filterChanged();
  }

  function buildLevelMenu() {
    const actions = document.createElement('div');
    actions.className = 'level-actions';
    for (const [label, value] of [['All', true], ['None', false]] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      scope.listen(button, 'click', event => {
        // buildLevelMenu() below replaces this button's DOM node, detaching it
        // before the document-level click listener runs in the bubble phase —
        // without stopping propagation here, container.contains(event.target)
        // would then see a detached node and incorrectly close the popover.
        event.stopPropagation();
        setAllLevels(value);
      });
      actions.append(button);
    }
    const labels = LEVELS.map(level => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.checkedLevels.has(level);
      scope.listen(input, 'change', () => {
        if (input.checked)
          state.checkedLevels.add(level);
        else
          state.checkedLevels.delete(level);
        updateLevelButtonLabel();
        filterChanged();
      });
      label.append(input, document.createTextNode(' ' + LEVEL_LABELS[level]));
      return label;
    });
    elements.levelMenu.replaceChildren(actions, ...labels);
  }

  // Omitting `levels` entirely (the default, everything checked) lets the
  // store skip building a filter set at all; an empty array is a distinct,
  // deliberate "nothing checked", which is a real choice, not "no filter".

  let savedSearchSignature: string | undefined;

  function renderSearchState(searches: { saved: SavedSearch[]; }) {
    const signature = JSON.stringify(searches.saved ?? []);
    if (signature === savedSearchSignature)
      return;
    savedSearchSignature = signature;
    const makeButton = (item: SavedSearch, label: string, removable = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-item';
      button.textContent = label;
      button.title = item.query || item.serverId || '';
      scope.listen(button, 'click', () => {
        setQuery(item.query || '');
        state.selectedServer = item.serverId || '';
        state.checkedLevels = new Set(Array.isArray(item.levels) ? item.levels : LEVELS);
        elements.server.value = state.selectedServer;
        buildLevelMenu();
        updateLevelButtonLabel();
        for (const popover of popovers)
          popover.close();
        elements.search.focus();
        state.before = undefined;
        filterChanged();
      });
      if (!removable)
        return button;
      const row = document.createElement('div');
      row.className = 'search-item-row';
      row.append(button);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'search-remove';
      remove.textContent = '×';
      remove.title = 'Delete saved search';
      remove.setAttribute('aria-label', `Delete saved search: ${item.name}`);
      scope.listen(remove, 'click', event => { event.stopPropagation(); api.postMessage({ type: 'deleteSavedSearch', id: item.id }); });
      row.append(remove);
      return row;
    };
    const savedItems = (searches.saved ?? []).map(item => makeButton(item, item.name, true));
    elements.savedSearchList?.replaceChildren(...(savedItems.length ? savedItems : [emptyMessage('Save a search to reuse it here.')]));
  }

  function renderAutocomplete(data: Extract<HostMessage, { type: 'autocomplete'; }>) {
    if (!elements.fieldSuggestions)
      return;
    elements.fieldSuggestions.replaceChildren(...completeQuery(data.input, data.fields, data.values).map(value => {
      const option = document.createElement('option');
      option.value = value;
      // Quoting may interrupt the typed prefix in the replacement value.
      // Native datalists also match labels, so retain that prefix there.
      if (!value.toLowerCase().includes(data.input.toLowerCase())) option.setAttribute('label', data.input);
      return option;
    }));
    // clearAutocomplete removes this association to dismiss the native menu
    // promptly. Restore it whenever fresh suggestions arrive.
    elements.search.setAttribute('list', 'fieldSuggestions');
  }

  function clearAutocomplete() {
    elements.fieldSuggestions?.replaceChildren();
    // Removing the association closes the native dropdown immediately rather
    // than merely emptying its backing options.
    elements.search.removeAttribute('list');
  }

  scope.listen(elements.search, 'keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyDraft();
    } else if (event.key === 'Escape' && editingIndex !== undefined) {
      event.preventDefault();
      cancelEdit();
    } else if (event.key === 'Backspace' && !elements.search.value && editingIndex === undefined) {
      const values = tokens(appliedQuery);
      let index = values.length - 1;
      while (index >= 0 && values[index] === 'OR') index--;
      if (index >= 0) { event.preventDefault(); removeAt(index); }
    }
  });
  scope.listen(elements.search, 'focus', () => {
    if (editingIndex === undefined && elements.search.value === appliedQuery)
      elements.search.value = '';
  });
  scope.listen(elements.search, 'input', () => setError());
  scope.listen(elements.searchClear, 'click', event => { event.stopPropagation(); clear(); });

  renderChips();
  return { updateLevelButtonLabel, buildLevelMenu, renderSearchState, renderAutocomplete, clearAutocomplete,
    query, draft: () => elements.search.value, setQuery, appendQuery: (value: string) => setQuery(`${appliedQuery} ${value}`, true), clear };
}
