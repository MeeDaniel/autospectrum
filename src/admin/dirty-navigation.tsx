import { createContext } from 'preact';

export type RegisterDirtyEditor = (isDirty: () => boolean) => () => void;

export const DirtyNavigationContext = createContext<RegisterDirtyEditor | null>(null);
