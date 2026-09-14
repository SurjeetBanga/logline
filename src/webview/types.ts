import type { ViewRequest } from '../protocol/messages';
import type { PersistedState } from './state';
export interface WebviewApi {
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
  postMessage(message: ViewRequest): void;
}
export interface ViewerActions {
  request(force?: boolean): void;
  saveState(): void;
  filterChanged(): void;
  setFollowing(value: boolean): void;
  updateFollowControl(): void;
  updateModeLabel(): void;
}
declare global { function acquireVsCodeApi(): WebviewApi; }
