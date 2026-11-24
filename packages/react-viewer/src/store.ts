import { useMemo, useReducer } from 'react';
import type { ViewerAnnotation } from './xfdfCompat';

// Like web/src/state/store.ts, but every action is applied to the reducer's current state, so
// several changes inside one event (e.g. the eraser crossing three strokes) never undo each other.

interface State {
  annotations: ViewerAnnotation[];
  past: ViewerAnnotation[][];
  future: ViewerAnnotation[][];
  selectedId: string | null;
}

type Action =
  | { type: 'change'; fn: (list: ViewerAnnotation[]) => ViewerAnnotation[]; live?: boolean }
  | { type: 'checkpoint' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; id: string | null }
  | { type: 'reset'; annotations: ViewerAnnotation[] };

const LIMIT = 100;

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'change': {
      const annotations = a.fn(s.annotations);
      if (annotations === s.annotations) return s;
      const selectedId = annotations.some((x) => x.id === s.selectedId) ? s.selectedId : null;
      if (a.live) return { ...s, annotations, selectedId };
      return { annotations, selectedId, past: [...s.past, s.annotations].slice(-LIMIT), future: [] };
    }
    case 'checkpoint':
      return { ...s, past: [...s.past, s.annotations].slice(-LIMIT), future: [] };
    case 'undo': {
      if (!s.past.length) return s;
      return { ...s, annotations: s.past[s.past.length - 1], past: s.past.slice(0, -1), future: [s.annotations, ...s.future], selectedId: null };
    }
    case 'redo': {
      if (!s.future.length) return s;
      const [next, ...rest] = s.future;
      return { ...s, annotations: next, past: [...s.past, s.annotations], future: rest, selectedId: null };
    }
    case 'select':
      return { ...s, selectedId: a.id };
    case 'reset':
      return { annotations: a.annotations, past: [], future: [], selectedId: null };
  }
}

export function useViewerStore() {
  const [state, dispatch] = useReducer(reducer, { annotations: [], past: [], future: [], selectedId: null });
  const actions = useMemo(() => {
    const change = (fn: (list: ViewerAnnotation[]) => ViewerAnnotation[], live = false) => dispatch({ type: 'change', fn, live });
    return {
      add(a: ViewerAnnotation) {
        change((list) => [...list, a]);
        dispatch({ type: 'select', id: a.id });
      },
      update(id: string, patch: Partial<ViewerAnnotation>, live = false) {
        const now = new Date().toISOString();
        change((list) => list.map((a) => (a.id === id ? { ...a, ...patch, modifiedAt: now } : a)), live);
      },
      remove(id: string, live = false) {
        change((list) => (list.some((a) => a.id === id) ? list.filter((a) => a.id !== id) : list), live);
      },
      replaceAll: (list: ViewerAnnotation[]) => change(() => list),
      reset: (list: ViewerAnnotation[]) => dispatch({ type: 'reset', annotations: list }),
      checkpoint: () => dispatch({ type: 'checkpoint' }),
      undo: () => dispatch({ type: 'undo' }),
      redo: () => dispatch({ type: 'redo' }),
      select: (id: string | null) => dispatch({ type: 'select', id }),
    };
  }, []);
  return useMemo(() => ({ ...state, ...actions, canUndo: state.past.length > 0, canRedo: state.future.length > 0 }), [state, actions]);
}

export type ViewerStore = ReturnType<typeof useViewerStore>;
