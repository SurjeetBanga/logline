export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing viewer element: ${id}`);
  return node as T;
}
export function getElements() {
  return {
    logs: element<HTMLTableSectionElement>('logs'),
    cellFilterMenu: element<HTMLElement>('cellFilterMenu'),
    cellFilterLabel: element<HTMLElement>('cellFilterLabel'),
    cellFilterReason: element<HTMLElement>('cellFilterReason'),
    cellFilterInclude: element<HTMLButtonElement>('cellFilterInclude'),
    cellFilterExclude: element<HTMLButtonElement>('cellFilterExclude'),
    empty: element<HTMLElement>('empty'),
    searchEditor: element<HTMLElement>('searchEditor'),
    search: element<HTMLInputElement>('search'),
    searchChips: element<HTMLElement>('searchChips'),
    searchClear: element<HTMLButtonElement>('searchClear'),
    searchError: element<HTMLElement>('searchError'),
    copyResults: element<HTMLButtonElement>('copyResults'),
    fieldSuggestions: element<HTMLDataListElement>('fieldSuggestions'),
    searchHelp: element<HTMLButtonElement>('searchHelp'),
    searchHelpPanel: element<HTMLElement>('searchHelpPanel'),
    searchTools: element<HTMLButtonElement>('searchTools'),
    searchToolsPanel: element<HTMLElement>('searchToolsPanel'),
    saveSearch: element<HTMLButtonElement>('saveSearch'),
    savedSearchList: element<HTMLElement>('savedSearchList'),
    fieldsButton: element<HTMLButtonElement>('fieldsButton'),
    fieldsPanel: element<HTMLElement>('fieldsPanel'),
    fieldsAll: element<HTMLButtonElement>('fieldsAll'),
    fieldsNone: element<HTMLButtonElement>('fieldsNone'),
    fieldList: element<HTMLElement>('fieldList'),
    analyze: element<HTMLButtonElement>('analyze'),
    analysisDialog: element<HTMLDialogElement>('analysisDialog'),
    analysisClose: element<HTMLButtonElement>('analysisClose'),
    analysisStatus: element<HTMLElement>('analysisStatus'),
    analysisContent: element<HTMLElement>('analysisContent'),
    levelButton: element<HTMLButtonElement>('levelButton'),
    levelMenu: element<HTMLElement>('levelMenu'),
    server: element<HTMLButtonElement>('server'),
    scopeMenu: element<HTMLElement>('scopeMenu'),
    sourcesTab: element<HTMLButtonElement>('sourcesTab'),
    runsTab: element<HTMLButtonElement>('runsTab'),
    sourceMenu: element<HTMLElement>('sourceMenu'),
    sessionMenu: element<HTMLElement>('sessionMenu'),
    follow: element<HTMLButtonElement>('follow'),
    moreActions: element<HTMLButtonElement>('moreActions'),
    actionsMenu: element<HTMLElement>('actionsMenu'),
    help: element<HTMLButtonElement>('help'),
    helpBadge: element<HTMLElement>('helpBadge'),
    config: element<HTMLButtonElement>('config'),
    manage: element<HTMLButtonElement>('manage'),
    export: element<HTMLButtonElement>('export'),
    import: element<HTMLButtonElement>('import'),
    clear: element<HTMLButtonElement>('clear'),
    stop: element<HTMLButtonElement>('stop'),
    run: element<HTMLButtonElement>('run'),
    captureToggle: element<HTMLButtonElement>('captureToggle'),
    shareAgent: element<HTMLButtonElement>('shareAgent'),
    shareSpecificRuns: element<HTMLButtonElement>('shareSpecificRuns'),
    shareScope: element<HTMLElement>('shareScope'),
    status: element<HTMLElement>('status'),
    sessions: element<HTMLElement>('sessions'),
    command: element<HTMLElement>('command'),
    older: element<HTMLButtonElement>('older'),
    newer: element<HTMLButtonElement>('newer'),
    page: element<HTMLElement>('page'),
    mode: element<HTMLElement>('mode'),
    counts: element<HTMLElement>('counts'),
    contextDialog: element<HTMLDialogElement>('contextDialog'),
    contextClose: element<HTMLButtonElement>('contextClose'),
    contextExport: element<HTMLButtonElement>('contextExport'),
    contextStatus: element<HTMLElement>('contextStatus'),
    contextLogs: element<HTMLTableSectionElement>('contextLogs'),
    contextDetails: element<HTMLElement>('contextDetails'),
    saveSearchDialog: element<HTMLDialogElement>('saveSearchDialog'),
    saveSearchForm: element<HTMLFormElement>('saveSearchForm'),
    saveSearchName: element<HTMLInputElement>('saveSearchName'),
    saveSearchCancel: element<HTMLButtonElement>('saveSearchCancel')
  };
}
export type Elements = ReturnType<typeof getElements>;
export function cell(text: string | number | boolean | undefined, className?: string) {
  const element = document.createElement('td');
  element.textContent = String(text ?? '');
  if (className)
    element.className = className;
  return element;
}

export function emptyMessage(text: string) {
  const message = document.createElement('p');
  message.className = 'popover-empty';
  message.textContent = text;
  return message;
}
