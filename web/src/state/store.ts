import { useCallback, useMemo, useReducer } from 'react';
import type { Annotation } from '../sdk/types';

interface State {
  annotations: Annotation[];
  past: Annotation[][];
  future: Annotation[][];
  selectedId: string | null;
}

type Action =
  | { type: 'commit'; annotations: Annotation[] } // undoable change
  | { type: 'live'; annotations: Annotation[] } // in-progress drag, no history entry
  | { type: 'checkpoint' } // remember state before a drag
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; id: string | null }
  | { type: 'reset'; annotations: Annotation[] };

const LIMIT = 200;

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'commit':
      return { ...s, annotations: a.annotations, past: [...s.past, s.annotations].slice(-LIMIT), future: [] };
    case 'live':
      return { ...s, annotations: a.annotations };
    case 'checkpoint':
      return { ...s, past: [...s.past, s.annotations].slice(-LIMIT), future: [] };
    case 'undo': {
      if (!s.past.length) return s;
      const prev = s.past[s.past.length - 1];
      return { ...s, annotations: prev, past: s.past.slice(0, -1), future: [s.annotations, ...s.future] };
    }
    case 'redo': {
      if (!s.future.length) return s;
      const [next, ...rest] = s.future;
      return { ...s, annotations: next, past: [...s.past, s.annotations], future: rest };
    }
    case 'select':
      return { ...s, selectedId: a.id };
    case 'reset':
      return { annotations: a.annotations, past: [], future: [], selectedId: null };
  }
}

export function useAnnotationStore() {
  const [state, dispatch] = useReducer(reducer, { annotations: [], past: [], future: [], selectedId: null });

  const add = useCallback(
    (a: Annotation) => {
      dispatch({ type: 'commit', annotations: [...state.annotations, a] });
      dispatch({ type: 'select', id: a.id });
    },
    [state.annotations],
  );

  const update = useCallback(
    (id: string, patch: Partial<Annotation>, live = false) => {
      const now = new Date().toISOString();
      const annotations = state.annotations.map((a) => (a.id === id ? { ...a, ...patch, modifiedAt: now } : a));
      dispatch({ type: live ? 'live' : 'commit', annotations });
    },
    [state.annotations],
  );

  const remove = useCallback(
    (id: string) => {
      dispatch({ type: 'commit', annotations: state.annotations.filter((a) => a.id !== id) });
      if (state.selectedId === id) dispatch({ type: 'select', id: null });
    },
    [state.annotations, state.selectedId],
  );

  return useMemo(
    () => ({
      ...state,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
      add,
      update,
      remove,
      checkpoint: () => dispatch({ type: 'checkpoint' }),
      undo: () => dispatch({ type: 'undo' }),
      redo: () => dispatch({ type: 'redo' }),
      select: (id: string | null) => dispatch({ type: 'select', id }),
      reset: (annotations: Annotation[]) => dispatch({ type: 'reset', annotations }),
      importMany: (list: Annotation[]) => dispatch({ type: 'commit', annotations: [...state.annotations, ...list] }),
      replaceAll: (list: Annotation[]) => dispatch({ type: 'commit', annotations: list }),
    }),
    [state, add, update, remove],
  );
}

export type AnnotationStore = ReturnType<typeof useAnnotationStore>;
