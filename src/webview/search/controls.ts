import type { HostMessage } from '../../protocol/messages';
import { completeQuery } from '../../core/query-completion';
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
  // A checkbox per level (any combination, Kayak-filter style) rather than a
  // single "at least X" choice, so e.g. Info + Error but not Warn is possible.

  const LEVEL_LABELS: Record<string, string> = { trace: 'Trace', debug: 'Debug', info: 'Info', warn: 'Warn', error: 'Error', fatal: 'Fatal' };

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
        elements.search.value = item.query || '';
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

  return { updateLevelButtonLabel, buildLevelMenu, renderSearchState, renderAutocomplete, clearAutocomplete };
}
